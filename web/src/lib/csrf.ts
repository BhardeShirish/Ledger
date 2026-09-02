export function csrfToken(): string | undefined {
  const encoded = document.cookie
    .split("; ")
    .find((row) => row.startsWith("ledger_csrf="))
    ?.split("=")
    .slice(1)
    .join("=");
  return encoded ? decodeURIComponent(encoded) : undefined;
}
