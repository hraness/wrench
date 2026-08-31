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
  derivatives: readonly [
    Readonly<{
      height: 216;
      sha256: string;
      src: `/images/editorial/${string}-384.webp`;
      width: 384;
    }>,
    Readonly<{
      height: 432;
      sha256: string;
      src: `/images/editorial/${string}-768.webp`;
      width: 768;
    }>,
  ];
  height: 864;
  imageSha256: string;
  provenance: Readonly<{
    job: string;
    prompt: string;
    promptSha256: string;
    receipt: string;
  }>;
  src: `/images/editorial/${string}.webp`;
  title: string;
  width: 1536;
}>;

const credit = "Editorial illustration generated for Wrench with Atet.";

export const editorialImages = [
  {
    alt: "Many branching browser windows contrasted with one bounded operation path and receipt",
    canonicalPath: "/compare/personal-agents-browser-use/",
    caption: "General browser paths and one named operation solve different jobs.",
    cardDescription: "Why Wrench exposes named operations instead of falling back to general browser control.",
    cardTitle: "Browser-using agents and named operations",
    credit,
    derivatives: [
      {
        height: 216,
        sha256: "e0c64330bd289346d1525399f6f98b79c865d99bc4416bf87b9aec39499afef7",
        src: "/images/editorial/personal-agents-browser-use-384.webp",
        width: 384,
      },
      {
        height: 432,
        sha256: "a5b99a499e0263461274a83ef24eb0dfd3e666be381ccc7b1e98400516f41563",
        src: "/images/editorial/personal-agents-browser-use-768.webp",
        width: 768,
      },
    ],
    height: 864,
    imageSha256: "482c7291a484712f8baae25d6cca945caf770c567ec5144a4d55fe3a60f8483d",
    provenance: {
      job: "editorial-provenance/personal-agents-browser-use/job.json",
      prompt: "editorial-provenance/personal-agents-browser-use/prompt.txt",
      promptSha256: "ca8732247170e0df20119e1f528699943f807e6f140c2850887c6df2878022c7",
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
    derivatives: [
      {
        height: 216,
        sha256: "a8ccf9a07d8c42ff57cf860cbbb7110acd8c2cb53d2c34232476513c66b1efe8",
        src: "/images/editorial/agentic-web-spoofing-384.webp",
        width: 384,
      },
      {
        height: 432,
        sha256: "cbad44e839f07b0e7bc4416669805d8f966b7cdcb71f2eecbe47e95b2a59b394",
        src: "/images/editorial/agentic-web-spoofing-768.webp",
        width: 768,
      },
    ],
    height: 864,
    imageSha256: "c0a9d91d6ea69998473912683caa8f74e967d775ae40a7250a638335d515016b",
    provenance: {
      job: "editorial-provenance/agentic-web-spoofing/job.json",
      prompt: "editorial-provenance/agentic-web-spoofing/prompt.txt",
      promptSha256: "0dd95428231fee8662d8441d2333fb07871acf8b80d6bebaa09e42d5acff6621",
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
    derivatives: [
      {
        height: 216,
        sha256: "4769a9aa9e477586b9ac5e3d0a36e48470494c86439e8d7d7db3d3b42d28a143",
        src: "/images/editorial/vms-cannot-contain-agents-384.webp",
        width: 384,
      },
      {
        height: 432,
        sha256: "fa8989edc05ce9a1e82816fc929af39c4ffd3164c0211ad2ccb5084c58e5237a",
        src: "/images/editorial/vms-cannot-contain-agents-768.webp",
        width: 768,
      },
    ],
    height: 864,
    imageSha256: "32cb5f31e6388c7e177af0b5a2c07fe4fb9bebf60892d1ec9935d6c86917adda",
    provenance: {
      job: "editorial-provenance/vms-cannot-contain-agents/job.json",
      prompt: "editorial-provenance/vms-cannot-contain-agents/prompt.txt",
      promptSha256: "8c1ad33c417c4e47a6086e396ac97f0ae0234417f9da64f89f2d6b5a318bd7ab",
      receipt: "editorial-provenance/vms-cannot-contain-agents/receipt.json",
    },
    src: "/images/editorial/vms-cannot-contain-agents.webp",
    title: "VMs cannot contain agents, and why attested web operations still matter",
    width: 1536,
  },
] as const satisfies readonly EditorialImage[];

export type EditorialPath = (typeof editorialImages)[number]["canonicalPath"];

export const EDITORIAL_ARTICLE_IMAGE_SIZES =
  "(max-width: 31.25rem) calc(100vw - 2.5rem), (max-width: 63rem) 92vw, 58rem" as const;
export const EDITORIAL_CARD_IMAGE_SIZES =
  "(max-width: 31.25rem) calc(100vw - 2.5rem), (max-width: 45rem) 92vw, (max-width: 80rem) 46vw, (max-width: 100rem) calc(40rem - 4vw), 36rem" as const;

export function editorialImage(path: string): EditorialImage | undefined {
  return editorialImages.find((image) => image.canonicalPath === path);
}

export function editorialImageUrl(image: EditorialImage): string {
  return `https://wrench.rip${image.src}`;
}

export function editorialImageSrcSet(image: EditorialImage): string {
  return [
    ...image.derivatives.map((derivative) => `${derivative.src} ${derivative.width}w`),
    `${image.src} ${image.width}w`,
  ].join(", ");
}
