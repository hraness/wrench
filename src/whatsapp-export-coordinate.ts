import { dirname, isAbsolute, resolve } from "node:path";

const WHATSAPP_EXPORT_AUTH_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const MAX_WHATSAPP_EXPORT_OUTPUT_BYTES = 4_096;

export function isWhatsAppExportAuthId(value: unknown): value is string {
  return typeof value === "string" && WHATSAPP_EXPORT_AUTH_ID_PATTERN.test(value);
}

export function isWhatsAppExportOutputDirectory(value: unknown): value is string {
  return typeof value === "string"
    && isAbsolute(value)
    && resolve(value) === value
    && dirname(value) !== value
    && Buffer.byteLength(value, "utf8") <= MAX_WHATSAPP_EXPORT_OUTPUT_BYTES
    && !/[\0\r\n]/u.test(value);
}
