#!/usr/bin/env bash
# Sourced by scripts/deploy-revision.sh, whose comment above the first read
# says what read_env_file FILE does; env_file_assignments is its result.
# shortcut: systemd refuses a file with invalid UTF-8 and stops at a NUL byte;
# this does neither, so such a unit fails to start, which is-active surfaces.
read_env_file() {
  local LC_ALL=C bytes c i n state=pre_key key='' value='' key_ws=-1 value_ws=-1
  bytes=$(timeout "${OVERFLOW_DEPLOY_ENV_READ_TIMEOUT:-5}" cat -- "$1" 2>/dev/null && printf x) || return
  bytes=${bytes%x} n=${#bytes} env_file_assignments=()
  for ((i = 0; i < n; i++)); do
    c=${bytes:i:1}
    case $state:$c in
      pre_key:[#\;]) state=comment ;;
      pre_key:[$' \t\n\r'] | pre_value:[$' \t']) ;;
      pre_key:*) state=key key=$c key_ws=-1 ;;
      key:[$'\n\r']) state=pre_key ;;
      key:=) state=pre_value value='' value_ws=-1 ;;
      key:[$' \t']) ((key_ws >= 0)) || key_ws=${#key}; key+=$c ;;
      key:*) key_ws=-1 key+=$c ;;
      pre_value:[$'\n\r'] | value:[$'\n\r']) env_file_push ;;
      pre_value:\') state=single ;;
      pre_value:\") state=double ;;
      pre_value:\\ | value:\\) state=value_escape value_ws=-1 ;;
      pre_value:* | value_escape:*) state=value; [[ $c == [$'\n\r'] ]] || value+=$c ;;
      value:[$' \t']) ((value_ws >= 0)) || value_ws=${#value}; value+=$c ;;
      value:*) value_ws=-1 value+=$c ;;
      single:\' | double:\") state=pre_value ;;
      double:\\) state=double_escape ;;
      single:* | double:*) value+=$c ;;
      double_escape:[\"\\\`\$]) state=double value+=$c ;;
      double_escape:$'\n') state=double ;;
      double_escape:*) state=double value+="\\$c" ;;
      comment:[$'\n\r']) state=pre_key ;; # COMMENT_ESCAPE acts as COMMENT since v254
    esac
  done
  [[ $state == pre_key || $state == key || $state == comment ]] || env_file_push
}

# Trailing whitespace off the key and an unquoted value; invalid names dropped.
env_file_push() {
  ((key_ws < 0)) || key=${key:0:key_ws}
  [[ $state != value ]] || ((value_ws < 0)) || value=${value:0:value_ws}
  # shellcheck disable=SC2034 # read by the sourcing script
  [[ ! $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || env_file_assignments+=("$key=$value")
  state=pre_key
}
