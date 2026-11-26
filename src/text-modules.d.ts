// `import x from "./file.sql" with { type: "text" }` yields the file's text (Bun inlines it, also in `bun build --compile`).
declare module "*.sql" {
  const text: string;
  export default text;
}
