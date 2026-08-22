import { handleDocumentNegotiation } from "./website/document-negotiation";

export default async function middleware(request: Request): Promise<Response | undefined> {
  return await handleDocumentNegotiation(request, (url) => fetch(url)) ?? undefined;
}

export const config = {
  matcher: [
    "/",
    "/((?!assets/).*)",
  ],
};
