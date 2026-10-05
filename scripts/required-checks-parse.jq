      def ispath: type == "string" and test("\\A\\.github/workflows/[^/]+\\.ya?ml\\z");
      def pinpaths: if type == "string" then [.] elif (type == "array" and length > 0) then . else null end;
      if length == 1
          and (.[0] | type == "object" and all(.[]; pinpaths != null and all(pinpaths[]; ispath)))
      then .[0] | to_entries[] | .key as $key | (.value | pinpaths[]) | [$key, .] | @tsv
      else error("not exactly one object of .github/workflows/*.yml paths or non-empty lists of them") end
