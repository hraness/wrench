import type {
  WhatsAppMessageLikeMeClientRequest,
  WhatsAppMessageLikeMeExportReceipt,
} from "./whatsapp-client-types";

function fail(message: string): never {
  throw new Error(`Wrench WhatsApp client: ${message}`);
}

export function requireWhatsAppMessageLikeMeReceiptRequestBinding(
  receipt: WhatsAppMessageLikeMeExportReceipt,
  request: WhatsAppMessageLikeMeClientRequest,
): WhatsAppMessageLikeMeExportReceipt {
  if (receipt.auth.id !== request.authId) {
    return fail("receipt auth identity does not match the requested auth locator");
  }
  if (receipt.output.directory !== request.output) {
    return fail("receipt output directory does not match the requested output");
  }
  return receipt;
}
