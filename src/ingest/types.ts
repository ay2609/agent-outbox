// Shapes shared inside the ingest library.
import type { MatchStatus } from "../core/types";

export type FieldName = "display_name" | "given_name" | "family_name" | "phone" | "email" | "org" | "notes" | "tags";
export const FIELD_NAMES: FieldName[] = ["display_name", "given_name", "family_name", "phone", "email", "org", "notes", "tags"];

export interface ParsedTable {
  kind: string; // csv|tsv|xlsx|xls|ods|numbers|vcf|json|jsonl|text
  sheets: string[];
  sheet: string | null;
  columns: string[];
  rows: Record<string, string>[];
  warnings: string[];
  /** Columns whose header was generated ("Column 4") although a header row was found and the column holds data. */
  unlabeled?: string[];
}

/** One mapped field. `column` is the primary column; for phone, email and tags `columns` is the whole ordered list
 *  (mobile / cell / iPhone first), `column` being its first entry. Old stored mappings have only `column`. */
export interface FieldMapping { column: string; confidence: number; columns?: string[] }

export interface Mapping {
  fields: Partial<Record<FieldName, FieldMapping>>;
  vars: Record<string, string>; // slug -> column
  confirmed: boolean;
  /** Default country for phone numbers without a country code (ISO 3166 alpha-2, default "US"). */
  region?: string;
}

export interface IssueCandidate { contact_id: string; display_name: string; phones: string[]; emails: string[] }
export interface ImportIssue {
  code:
    | "invalid_phone" | "invalid_email" | "no_handle" | "non_mobile" | "missing_name" | "phone_note"
    | "duplicate_of_row" | "duplicate_person" | "ambiguous_name" | "ambiguous_handle";
  message: string;
  row?: number;
  candidates?: IssueCandidate[];
}

export interface NormalizedRow {
  given_name: string;
  family_name: string;
  display_name: string;
  phone_e164: string | null;
  email: string | null;
  org: string;
  notes: string;
  tags: string[];
  /** The address a draft would go to: the valid phone, else the valid email. */
  handle: string | null;
  handle_kind: "phone" | "email" | null;
  mobile: boolean | null;
  /** Every valid phone (E.164) and email in the row, best first. Matching against contacts tries all of them. */
  phones?: string[];
  emails?: string[];
  vars: Record<string, string>;
}

export interface ImportRowRecord {
  row_index: number;
  raw: Record<string, string>;
  normalized: NormalizedRow;
  contact_id: string | null;
  match: MatchStatus;
  issues: ImportIssue[];
  /** Everything a template can use for this row (standard fields, every column slug, tags). Filled by getImport. */
  vars?: Record<string, string>;
}

export interface ImportSummary {
  import_id: string;
  filename: string;
  kind: string;
  sheet: string | null;
  sheets: string[];
  columns: string[];
  mapping: Mapping;
  needs_confirmation: boolean;
  counts: Record<MatchStatus, number>;
  preview: ImportRowRecord[];
  warnings: string[];
  /** Column names that were generated for data columns without a header; they force confirmation. */
  unlabeled_columns?: string[];
}
