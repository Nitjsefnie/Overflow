import type { Sql, TransactionSql } from "postgres";

export type DatabaseId = string;
export type SqlClient = Sql;
export type TransactionClient = TransactionSql;
export type TransactionCallback<T> = (sql: TransactionClient) => T | Promise<T>;

export type UserRole = "MEMBER" | "MODERATOR";
export type EnforcementState = "ACTIVE" | "UNDER_AUDIT" | "WARNED" | "RECALIBRATING" | "BANNED";
export type RepositoryVisibility = "PUBLIC" | "PRIVATE";
export type IssueState = "OPEN" | "CLOSED";
export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";
export type SettlementStatus = "SETTLED" | "UNSETTLED";
