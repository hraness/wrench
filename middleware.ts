import { handleDocumentNegotiation } from "./edge/negotiation";

export default async function middleware(request: Request): Promise<Response | undefined> {
  return await handleDocumentNegotiation(request, (url) => fetch(url)) ?? undefined;
}

export const config = {
  matcher: [
    "/",
    "/((?!assets/).*)",
  ],
};
