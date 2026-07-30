export interface ReviewedBuiltInContractIdentityV1 {
  readonly schemaVersion: 1;
  readonly pluginVersion: string;
  /** Canonical writer identity from the predecessor runtime with NODE_ENV unset. */
  readonly implementationSha256: string;
  /** Exact b64ccd66 predecessor execution identities accepted only by readers. */
  readonly legacyReadImplementationSha256: Readonly<{
    readonly test: string;
    readonly production: string;
    readonly development: string;
  }>;
  /** Exact later e71c9bd3 predecessor-runtime identities, kept as one distribution. */
  readonly legacyE71ReadImplementationSha256: Readonly<{
    readonly default: string;
    readonly test: string;
    readonly production: string;
    readonly development: string;
  }>;
  /** Distribution-specific, environment-independent current closure attestations. */
  readonly reviewedClosureSha256: readonly string[];
}

const identities = Object.freeze({
  "bluesky-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "9bdebb45464120249abc8b9d74068f8921b19c999429a74cfef67d06b7816ccc",
    legacyReadImplementationSha256: {
      test: "49cef73be8ec202c2f991092020e4106c84f0f8b8fa6f5f2c89cd79df285fe43",
      production: "85170f98a6fc658021e83192e07fd3186bcdc3f9bc958d323c874a5e15a4a82d",
      development: "200f125ea0b219b045e99a4cddc9da28ed510be52d830c4e1abefe722c219fae",
    },
    legacyE71ReadImplementationSha256: {
      default: "bef6a8762825a070015aabbb019e32974ddef1a960e0e2901d3d4b168ad48804",
      test: "f8e82be035f3280809a3941b81a2c10a354a73006edfbbdc5e89207bc036244d",
      production: "89d80d4603413a79092c369572f571cb3d36fe1716b401d00ba0f55019d9f306",
      development: "d5ada0c9f22748494b12def42560c761777e69f5a58496523cd9641984787aa5",
    },
    reviewedClosureSha256: [
      "eea1bb952545f6b3cf2ec735bb5449d3f542c9c21cf23ba89180f05cb42dc814",
      "684517eb2d5c84c6f47c727dd18ce6122a7fb037ce6edde1312fc8036f74b80b",
      "634483110c47ac7f9f3b5603f30b9933768375577a551ae9b78f91a7cfab8162",
      "c49343947c17b896203c287742ecbd971b5b2edf8f488b30ca8d2da785744cd8",
      "f05aa56dfcb69977301879f1b13c2f9bb59ac82ee61dd24e5ddb6b420ccf3e21",
      "60695c6131d96c27414f6b1c687fb9929fc18742f21f339dd02861cc03f18748",
    ],
  },
  "hacker-news-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "da3cdd6465b92ce933004fb9e3f2bf3dd48811e766079647d2cdaec43e507e1d",
    legacyReadImplementationSha256: {
      test: "e4c9e459c0185428d759994a160200b5d883119caca828b6ae7469124ef82f14",
      production: "c54f71de41c0df51a36f8a1c80b092b4534ffbd16aedacfba599d68e8f6b4130",
      development: "ff716adff5a4f962a765020474325037d0d4795c61f086c13e5d2adc61484ec8",
    },
    legacyE71ReadImplementationSha256: {
      default: "da3cdd6465b92ce933004fb9e3f2bf3dd48811e766079647d2cdaec43e507e1d",
      test: "e4c9e459c0185428d759994a160200b5d883119caca828b6ae7469124ef82f14",
      production: "c54f71de41c0df51a36f8a1c80b092b4534ffbd16aedacfba599d68e8f6b4130",
      development: "ff716adff5a4f962a765020474325037d0d4795c61f086c13e5d2adc61484ec8",
    },
    reviewedClosureSha256: [
      "66bd89c3cec17a41a4b629e0eb74737ce7ecbd92eef8f85c97eba9a5035aec3c",
      "369706494465e302cccfbe7a996082d315a360b1ed1539856acdfac3e75888a5",
    ],
  },
  "linkedin-official": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "b279da0925b7f5f75066a07eca59610132da82caf385d83bc02e8b9d135aa121",
    legacyReadImplementationSha256: {
      test: "bd53061f2cd8d9089e82143c546e1b79d5352077d9c701ad27975179dc4e1c96",
      production: "7cd9fae0e9aaf198a3944508455b2e6a74bc3bc7bf7329dd156c3091e7193e5d",
      development: "6fd3705ab96ac48ae3f2ef014ef6ea3fc7ec2452d255cd27ae1b0347c2e4975e",
    },
    legacyE71ReadImplementationSha256: {
      default: "b279da0925b7f5f75066a07eca59610132da82caf385d83bc02e8b9d135aa121",
      test: "bd53061f2cd8d9089e82143c546e1b79d5352077d9c701ad27975179dc4e1c96",
      production: "7cd9fae0e9aaf198a3944508455b2e6a74bc3bc7bf7329dd156c3091e7193e5d",
      development: "6fd3705ab96ac48ae3f2ef014ef6ea3fc7ec2452d255cd27ae1b0347c2e4975e",
    },
    reviewedClosureSha256: [
      "a27ff58f2ea21df58ff71b0683ee038207e7aa7a5c199fcb04f4193f9e8e3c5c",
      "cc0b8f6bc9f514e065565a4ab7094732f4aef314d01ef48a9d4be4e64952f19b",
    ],
  },
  "linkedin-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "6acaacfa89928b5d31144eda506fe94040810ac90b61c0ae642e38ec13311237",
    legacyReadImplementationSha256: {
      test: "00a99426ec31182f8d37d5cceb819947a09e630b468bb6e3ed8827f5b0fa4628",
      production: "1ca3e1dcff51ae5557cd55a7d4ed95fbb2d1de6cd98791a99fb92b519e2346e5",
      development: "c3586d7f4eadd0f822f2f51f5719929c8210514cb6f6e7934030d5f4306c1bf0",
    },
    legacyE71ReadImplementationSha256: {
      default: "a8355972fff8da1370cb7022b1fcc5af07155162f45785578f190623a07a3821",
      test: "12faf713184aebc92a170f4d8f2fcea7edaa1e6c37bb63db5197c693c768452b",
      production: "ddcff51fbfebab8f67dc0049137d7ac7ec7d3315f50f4b23fe1f05f14af1a3bc",
      development: "101e7f112a6e563a875dcc5ece4d97bfa5b7c30950de8c4da8d3fad3eaf27c41",
    },
    reviewedClosureSha256: [
      "e8afbfb439cbb3c0d33088fb06077ca241817beba711c100344418ac01c410eb",
      "b68a84b2e2b626f19fc92c37d72916562a7dce6e91269373aa5590b930579851",
      "78285b1b44006bb6ce65061008e3c4cdfd9ca093d3e58eaff442f95f1ad83432",
      "f1f722aaa58e85940849828fcbadbcd68d7f5d32b174f7ab0a7c5ac9b1e0d2cc",
      "8c1fe501c90014d7e5b7724c466c12e2eeb7c27f460e9f4cf42faf413ae1e215",
      "44e0b5de1581b9d5844b061087380847cb6e804c6d2f0eccdd7d119e7ce04cab",
    ],
  },
  "meta-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "2267887ca46e413fab5fded684edb1bab495b4782925f6be67153195131ad6c6",
    legacyReadImplementationSha256: {
      test: "398b1b05ef6493dab56e37d2edb440b1a591163148d861dda475b17941b81225",
      production: "ce165bd29547d1b57070857720464495cf91c39d4d2ac34cbdf5921336abf402",
      development: "5a2e6f985d692d9170e299d15908a20b96be2214f51ca81e90079d2b750d9227",
    },
    legacyE71ReadImplementationSha256: {
      default: "fc6875171617dfe466f1e39308b8a208253b7b4adae3201f58634cfd43c30913",
      test: "ee800a30b1800646209eb9099f1520d70b42033962c8296129e37ff9247ee6f7",
      production: "6d8840ab038514bea52c5fee62446d4190a10770b6d85a74ab3aab6a0c993b20",
      development: "1339b1d792a6cfd8e411d90ec419f8c2ab5de35edb38ff10941481fae1ade8e9",
    },
    reviewedClosureSha256: [
      "d2ee6cccdb8122f575bee2a9edca36e1bf9c2fa9bc9e6def00fd63139778bee3",
      "8c9c5574ff06688ae35f2a54ec968b4725927db192db3a5cec9679c68cd80e47",
      "d099303fa7ab8f6b3ed6699326ea43b071c96f2280d52fd1bacc865c34da1e0d",
      "5b20f9db784e3d2a51e5a4bae5800c3fef9efdca4e28b0909e9a9bfb5ef97c4f",
      "19d65a042a1533515c6fa79f5177762530da80b4ece69eea3114ac6ec4a48403",
      "d20db0c78faac2af58c95e20e5a81b8c31dbca8e1c3a21f337d81f673b04acf7",
    ],
  },
  "reddit-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "dea85e9a5bc2a134ce48769655c2e4df89d68a876012b4af3e08f40526d02512",
    legacyReadImplementationSha256: {
      test: "64a4c1e78ce8565a50613f63ff605f0f57f488617ef31386b5ddce5e3db885c9",
      production: "058987e5eac61505ca53f80d8494fb5505e697e0313e6e197a198649be7c3a3c",
      development: "05173089ec6d555845fa5fb7b08a70bd0bf810a18882c9ecdd784a437db791c5",
    },
    legacyE71ReadImplementationSha256: {
      default: "dea85e9a5bc2a134ce48769655c2e4df89d68a876012b4af3e08f40526d02512",
      test: "64a4c1e78ce8565a50613f63ff605f0f57f488617ef31386b5ddce5e3db885c9",
      production: "058987e5eac61505ca53f80d8494fb5505e697e0313e6e197a198649be7c3a3c",
      development: "05173089ec6d555845fa5fb7b08a70bd0bf810a18882c9ecdd784a437db791c5",
    },
    reviewedClosureSha256: [
      "64c159e9f170eff7a83e86152fc0a7a99625312cf2aa7b00e920a7bd2b65441d",
      "cde0cd4fe8954aff68ad86e537edfbf0b876eaeffc3d34f68d84a91e8f7067e4",
    ],
  },
  "substack-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "4fbfe4ae9638728c1ce48c15e0c8b2343a39c372ab01d8b5f6a75665af0df040",
    legacyReadImplementationSha256: {
      test: "99fc0287f9445b0e4d692e39201ebb8b9e9bb86308c9619c20e3bff83655243d",
      production: "fb58ac6ba745b2dc4dc176e8e3b7f4d3362cd8026d3e00557f72342b76b7c519",
      development: "58c2b588db7154883a154d05194cde62ff19b8e14045d10f854aacc9a4433e73",
    },
    legacyE71ReadImplementationSha256: {
      default: "4fbfe4ae9638728c1ce48c15e0c8b2343a39c372ab01d8b5f6a75665af0df040",
      test: "99fc0287f9445b0e4d692e39201ebb8b9e9bb86308c9619c20e3bff83655243d",
      production: "fb58ac6ba745b2dc4dc176e8e3b7f4d3362cd8026d3e00557f72342b76b7c519",
      development: "58c2b588db7154883a154d05194cde62ff19b8e14045d10f854aacc9a4433e73",
    },
    reviewedClosureSha256: [
      "e50798cdad324f91eee0e2c7c0d14e4b871856dc110dd6b107c70f31e5b8221c",
      "9f54941ccb4eabdc02d28ad84f65d0357b50d3c7adaf124e989ffdb013f3daa7",
    ],
  },
  "tiktok-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "48caac81218d23b00b2c48ab70fc6c135ae70228c4b2db90cc4626848dab67d5",
    legacyReadImplementationSha256: {
      test: "09f48f093e444206b5ef41fae135a1543d4cf1217d590978b9a1470ccb7a1df3",
      production: "dd1b13afa9a164e40c1dce423a5808e1cd8bafddf39a83c59d5ee83c1474705f",
      development: "0f70eaee8275a922d6c6fff85507caf3f5000a8c7a32a3cc01f05d643da85b0d",
    },
    legacyE71ReadImplementationSha256: {
      default: "48caac81218d23b00b2c48ab70fc6c135ae70228c4b2db90cc4626848dab67d5",
      test: "09f48f093e444206b5ef41fae135a1543d4cf1217d590978b9a1470ccb7a1df3",
      production: "dd1b13afa9a164e40c1dce423a5808e1cd8bafddf39a83c59d5ee83c1474705f",
      development: "0f70eaee8275a922d6c6fff85507caf3f5000a8c7a32a3cc01f05d643da85b0d",
    },
    reviewedClosureSha256: [
      "089c9c6474c69aad4babd52bdea3f8bc47911eacdf9328978e5f284c92bc7d2f",
      "3d23a2953d0aafd2da64f2a05219861043a3cdd33845ab55d4ecc406e63f8d81",
    ],
  },
  "whatsapp-linked-device": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "4c58bd39ab0971764bc1361a8093f5965146c81e9be6785eb2c6c324765518c3",
    legacyReadImplementationSha256: {
      test: "7647d40e2dc89aa4562fd760b4a5616880412ffe8bc2e4e265b140e0f4515f28",
      production: "6b75371d75a8924b46523338c0ea96ece7cae4680a294bf89edc002bd286e803",
      development: "530e7c0705af04d5501cb2f6d3cfc9ecb9b5d3e23305d7b314fc646f7c304e39",
    },
    legacyE71ReadImplementationSha256: {
      default: "60876cd5a4648d0734c717faf7f22c6af6481847b8ff392ba15aeadf8e1c39a4",
      test: "f81d5e3ed96d780065569c8ee39606ee493cd0aa902a5619e1ccca2e82921068",
      production: "57536075d4a0fc223cb9116b6e89f0103cad5c7edf552f3c372f4f66bb1c4114",
      development: "5692fed6cbece0dc2a057d33f2e6d82220663f6edcac7cf636337f323c391f86",
    },
    reviewedClosureSha256: [
      "64ee39e4eca64b61e2e5361a412c2d635d329e2ae8f7ab505f0d117f8e186d72",
      "4d03dc005b88c715c2dcb05684d38999fb365c685bce64d626f7b5934ee8811f",
      "44fa92d824ee60fbf5caa6b21ec0ca095bddad8e8e14272235be127f6643e022",
      "12ae8ba6b0994bbb9dcc52bdc5d7ff489c9d3fce49f22c9e85b8f3a4c7f845c9",
      "f8d920d6dd84702e1c2c7bd5461926f599b202524ddddde971bcb9ed228f57ee",
      "5a980ab1aeed0f788f5cc44f6a88a2f28b9272a1cc93e42a3998784a3d5b68b8",
    ],
  },
  "x-official": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "b861f63def7aec7c0a90415df4c3bc1b6dc9eb9724d08c90dffa23a9482066cd",
    legacyReadImplementationSha256: {
      test: "8650f975d15a5a6d1daefc5a202d248612d2c702287fa554d4737abbad37cb4f",
      production: "4bdc46fbb5d224730ef2042239d72dcf84aabb3985c75d4a775bdec6b19e3706",
      development: "e5f5982e62b415ca7b4cfe314996377295d6bbc65574ab3e1b10639649418490",
    },
    legacyE71ReadImplementationSha256: {
      default: "b861f63def7aec7c0a90415df4c3bc1b6dc9eb9724d08c90dffa23a9482066cd",
      test: "8650f975d15a5a6d1daefc5a202d248612d2c702287fa554d4737abbad37cb4f",
      production: "4bdc46fbb5d224730ef2042239d72dcf84aabb3985c75d4a775bdec6b19e3706",
      development: "e5f5982e62b415ca7b4cfe314996377295d6bbc65574ab3e1b10639649418490",
    },
    reviewedClosureSha256: [
      "b6e2b143fea44019c11a5ade5a555f5d5683548630dd6cbaa810c43c3fa0c471",
      "f5e693393054655fe0b10eb7fcc468a7251f6a36eb02b4184df11ddcabbf2ae4",
    ],
  },
  "x-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "e3e73a938b442339034d4484ac6984f9c6beb612fff10d01a499bf326fd1b15a",
    legacyReadImplementationSha256: {
      test: "bcf7411c6ac01b16dc2a602b9928f8d0f9f5fd3ac0901d2ef197b72a8f763d31",
      production: "ebba20c72150dcef1eb21d3a1ea02a1dee91f8654c1f33621e5217faabf2be25",
      development: "c9e10ff1af5d4f102cfc73bc5b7def23a41db7cba978f516b0bc515616b6506c",
    },
    legacyE71ReadImplementationSha256: {
      default: "e3e73a938b442339034d4484ac6984f9c6beb612fff10d01a499bf326fd1b15a",
      test: "bcf7411c6ac01b16dc2a602b9928f8d0f9f5fd3ac0901d2ef197b72a8f763d31",
      production: "ebba20c72150dcef1eb21d3a1ea02a1dee91f8654c1f33621e5217faabf2be25",
      development: "c9e10ff1af5d4f102cfc73bc5b7def23a41db7cba978f516b0bc515616b6506c",
    },
    reviewedClosureSha256: [
      "6a92ce97a7d3c6d243943ebf8ab05e3a4de47bf4f7c33f0ce1c49cfa0f10cf6b",
      "971e28e03a8b21f5a8f4555f04b55865fd98c738b883f53a567925c8295176fc",
    ],
  },
  "youtube-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "b600cedf02a4360f4d74c2823a50d1f16b1409d879d839b1cd1dea874c721ef4",
    legacyReadImplementationSha256: {
      test: "02fe9106b2d620b3be3f4d0cd415ae7edebfe67997ae97c7fff8cedd4508b99f",
      production: "4de654022a34ac7dd93ef913fc9e7c5f5dfa992d573d53b27cb2fa60b1a730d3",
      development: "ce6527db4e1d109aa2d3d67ae81e8222568865edcba489528c30d5010137a1bd",
    },
    legacyE71ReadImplementationSha256: {
      default: "b600cedf02a4360f4d74c2823a50d1f16b1409d879d839b1cd1dea874c721ef4",
      test: "02fe9106b2d620b3be3f4d0cd415ae7edebfe67997ae97c7fff8cedd4508b99f",
      production: "4de654022a34ac7dd93ef913fc9e7c5f5dfa992d573d53b27cb2fa60b1a730d3",
      development: "ce6527db4e1d109aa2d3d67ae81e8222568865edcba489528c30d5010137a1bd",
    },
    reviewedClosureSha256: [
      "efabeb142292c2af49abc9d185481476d792a505635eef453828c544e61eda12",
      "5c69143794f108087f8ba0bd2f31c18fe1a9ac32b3761754cf4d75bd2041ae2e",
    ],
  },
} as const satisfies Readonly<Record<string, ReviewedBuiltInContractIdentityV1>>);

for (const identity of Object.values(identities)) {
  Object.freeze(identity.legacyReadImplementationSha256);
  Object.freeze(identity.legacyE71ReadImplementationSha256);
  Object.freeze(identity.reviewedClosureSha256);
  Object.freeze(identity);
}

export function reviewedBuiltInContractIdentity(
  pluginId: string,
  pluginVersion: string,
): ReviewedBuiltInContractIdentityV1 {
  const identity = identities[pluginId as keyof typeof identities];
  if (identity === undefined || identity.pluginVersion !== pluginVersion) {
    throw new Error(
      `built-in provider plugin ${pluginId}@${pluginVersion} has no reviewed durable contract identity`,
    );
  }
  return identity;
}
