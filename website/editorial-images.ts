export type EditorialImage = Readonly<{
  alt: string;
  canonicalPath:
    | "/compare/personal-agents-browser-use/"
    | "/agentic-web-spoofing/"
    | "/vms-cannot-contain-agents/";
  caption: string;
  cardDescription: string;
  cardTitle: string;
  credit: string;
  height: 864;
  imageSha256: string;
  provenance: Readonly<{
    job: string;
    prompt: string;
    receipt: string;
  }>;
  src: `/images/editorial/${string}.webp`;
  title: string;
  width: 1536;
}>;

const credit = "Editorial illustration generated for wrench.rip with Atet.";

export const editorialImages = [
  {
    alt: "Many branching browser windows contrasted with one bounded operation path and receipt",
    canonicalPath: "/compare/personal-agents-browser-use/",
    caption: "General browser paths and one named operation solve different jobs.",
    cardDescription: "Why Wrench exposes named operations instead of falling back to general browser control.",
    cardTitle: "Browser-using agents and named operations",
    credit,
    height: 864,
    imageSha256: "482c7291a484712f8baae25d6cca945caf770c567ec5144a4d55fe3a60f8483d",
    provenance: {
      job: "editorial-provenance/personal-agents-browser-use/job.json",
      prompt: "editorial-provenance/personal-agents-browser-use/prompt.txt",
      receipt: "editorial-provenance/personal-agents-browser-use/receipt.json",
    },
    src: "/images/editorial/personal-agents-browser-use.webp",
    title: "Browser-using personal agents, and which web operations Wrench attests",
    width: 1536,
  },
  {
    alt: "Similar identity masks casting different shadows beside one bounded outbound operation token",
    canonicalPath: "/agentic-web-spoofing/",
    caption: "An inbound identity claim is not the same proof as a named outbound operation.",
    cardDescription: "Why a failed inbound identity check does not establish a safe outbound operation.",
    cardTitle: "Agentic-web spoofing and outbound operations",
    credit,
    height: 864,
    imageSha256: "c0a9d91d6ea69998473912683caa8f74e967d775ae40a7250a638335d515016b",
    provenance: {
      job: "editorial-provenance/agentic-web-spoofing/job.json",
      prompt: "editorial-provenance/agentic-web-spoofing/prompt.txt",
      receipt: "editorial-provenance/agentic-web-spoofing/receipt.json",
    },
    src: "/images/editorial/agentic-web-spoofing.webp",
    title: "Agentic-web index spoofing, and why attested operations still matter",
    width: 1536,
  },
  {
    alt: "Tangled paths crossing nested translucent boxes beside one narrow named operation channel",
    canonicalPath: "/vms-cannot-contain-agents/",
    caption: "A broad machine boundary and a narrow named operation answer different questions.",
    cardDescription: "Why a virtual machine around an agent does not define a safe web operation.",
    cardTitle: "Virtual machines and attested operations",
    credit,
    height: 864,
    imageSha256: "32cb5f31e6388c7e177af0b5a2c07fe4fb9bebf60892d1ec9935d6c86917adda",
    provenance: {
      job: "editorial-provenance/vms-cannot-contain-agents/job.json",
      prompt: "editorial-provenance/vms-cannot-contain-agents/prompt.txt",
      receipt: "editorial-provenance/vms-cannot-contain-agents/receipt.json",
    },
    src: "/images/editorial/vms-cannot-contain-agents.webp",
    title: "VMs cannot contain agents, and why attested web operations still matter",
    width: 1536,
  },
] as const satisfies readonly EditorialImage[];

export type EditorialPath = (typeof editorialImages)[number]["canonicalPath"];

export function editorialImage(path: string): EditorialImage | undefined {
  return editorialImages.find((image) => image.canonicalPath === path);
}

export function editorialImageUrl(image: EditorialImage): string {
  return `https://wrench.rip${image.src}`;
}

export function editorialImageSrcSet(image: EditorialImage): string {
  const stem = image.src.slice(0, -".webp".length);
  return `${stem}-384.webp 384w, ${stem}-768.webp 768w, ${image.src} ${image.width}w`;
}
