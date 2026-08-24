export interface ReviewedBuiltInContractIdentityV1 {
  readonly schemaVersion: 1;
  readonly pluginVersion: string;
  /** Canonical durable writer identity for the current contract distribution. */
  readonly implementationSha256: string;
  /** Exact later current-distribution writer identities accepted only by readers. */
  readonly legacyCurrentReadImplementationSha256: readonly string[];
  /** Exact b64ccd66 predecessor execution identities accepted only by readers. */
  readonly legacyReadImplementationSha256: Readonly<{
    readonly test: string;
    readonly production: string;
    readonly development: string;
  }> | null;
  /** Exact later e71c9bd3 predecessor-runtime identities, kept as one distribution. */
  readonly legacyE71ReadImplementationSha256: Readonly<{
    readonly default: string;
    readonly test: string;
    readonly production: string;
    readonly development: string;
  }> | null;
}

const identities = Object.freeze({
  "beeper-linked-device": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "1110e1a6b99720c912451fa44d764f2f48590cbf7f2568aa199068adedf1c9f0",
    legacyCurrentReadImplementationSha256: [],
    legacyReadImplementationSha256: null,
    legacyE71ReadImplementationSha256: null,
  },
  "bluesky-web": {
    schemaVersion: 1,
    pluginVersion: "1.3.0",
    implementationSha256: "f16f456fd06952bdd28e4bbed6e6faaed9b2c18899487224453e7ef314f585e8",
    legacyCurrentReadImplementationSha256: [
      "81344b367a11c7dcaeff83386bc0f796c41260cb373b9818527f4cb55bc80d48",
      "e824f922748673edb9515055d208cfc4333c832b04cec528aa71f7be736e5846",
      "eb4cc4aa49296d11d2c36d798e5e3dd0b1664aa2d37e885ffd0919ad526d44d4",
      "9bdebb45464120249abc8b9d74068f8921b19c999429a74cfef67d06b7816ccc",
    ],
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
  },
  "gmail-official": {
    schemaVersion: 1,
    pluginVersion: "1.3.0",
    implementationSha256: "821e81dcd0d09756253ace93bece4b906c9fca3f1ab27adcbf0108a3fb0f6702",
    legacyCurrentReadImplementationSha256: [],
    legacyReadImplementationSha256: null,
    legacyE71ReadImplementationSha256: null,
  },
  "hacker-news-web": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "da3cdd6465b92ce933004fb9e3f2bf3dd48811e766079647d2cdaec43e507e1d",
    legacyCurrentReadImplementationSha256: [],
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
  },
  "linkedin-official": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "b279da0925b7f5f75066a07eca59610132da82caf385d83bc02e8b9d135aa121",
    legacyCurrentReadImplementationSha256: [],
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
  },
  "linkedin-web": {
    schemaVersion: 1,
    pluginVersion: "1.4.0",
    implementationSha256: "f327a0baca1831436dc98be657c72b52f4e70494ff0e90204ac8c21a17f6a0ea",
    legacyCurrentReadImplementationSha256: [
      "baa96307587140a460e39274dd2f0f0aab8bee125c34c62231038d0401a7e737",
      "65d95a47f238acf3fac02116a1c671c7a9659dab766bd8081ccf69d4495dccda",
      "dbda2aee2075a0a3726241fd24932113ae6c2d139ae1f7036ea827a335f7344c",
      "9acb34f9ef5f59dd46b249766af236a3876a4975e0797e330f2975b3fd4ed643",
      "951102310bd87f93ce0863c1a444371d62f412934cc805f82c9981f82edfe50e",
      "4fd6c293984be688a9273acb09bccea64a75134daca745b322fa8d33dfe9f97c",
      "624e146839f4d20d361a949c3ddb726f0c6b741f4d094e873e82185cf3f03175",
      "9e2baa00763f311fbb4c651c513793a356021f8a703f08e06f52437c01d02089",
      "a3a61f60dce97960a35d131b603a9543db02d43407ded4403675b729205fa256",
      "6acaacfa89928b5d31144eda506fe94040810ac90b61c0ae642e38ec13311237",
    ],
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
  },
  "meta-web": {
    schemaVersion: 1,
    pluginVersion: "1.2.0",
    implementationSha256: "8b5f59a6aa223ea1493fb49c2f9959565fef931318af55880973c3dd2758c101",
    legacyCurrentReadImplementationSha256: [
      "6f3f5d29dd6a8e19c2d6eba9bd92cce0406f24df9a6a8b121731f20ed5604994",
      "af2d809b8a18806c8f36e86660289c219a99eb0799baa42a2afbcfbc428e37c2",
      "5d62645a730274c6dc86dd058886a2eb6b9a8bddf94ba888f017b7294580e452",
      "b1e997c0540283f45b3b7b0f4c5712f8592e140a840bab75e463aac40efaa805",
      "2267887ca46e413fab5fded684edb1bab495b4782925f6be67153195131ad6c6",
      "5690d4ba2d37bce7aed32f12a44a2ed6066cb01c319674d37521f011122c9da7",
    ],
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
  },
  "reddit-web": {
    schemaVersion: 1,
    pluginVersion: "1.1.0",
    implementationSha256: "91cc3364ab1ccba66bd2e099f64fcccc187fde94145a8bf1eaa14f0f5533f6d7",
    legacyCurrentReadImplementationSha256: [],
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
  },
  "substack-web": {
    schemaVersion: 1,
    pluginVersion: "1.2.0",
    implementationSha256: "d35dda6043e224f4a2d6305a4a6aac9f05bef37ecfbfd087973394cdbe0c6811",
    legacyCurrentReadImplementationSha256: [
      "2062f7c39c75ce286f26e7bd513871e5cbc2b62e2408d20df28af906f8ad5012",
      "e4ba73882eb3f5bf489c88861cdd1fedd790a55af027e03ff5a07b526b8f0f5f",
      "96a992faae17420dc2ec74c9d22903bb7973f69d3f0de198800d357480651269",
    ],
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
  },
  "tiktok-web": {
    schemaVersion: 1,
    pluginVersion: "1.2.0",
    implementationSha256: "d92111d5ae92e002310ad201144b7a5cd05ad209cebac2fe2b31c3852cfca1cd",
    legacyCurrentReadImplementationSha256: [
      "d6693ee40e9de8f62a09f44000e7d5005d69715baa50c3034109a381f3c53180",
      "7d7f92ec9bbb5675102dd5cc0d1441334f723e66a7d9f5926e89a163c4cd2989",
      "48f1e574b3e897b51a1ea90bdf26280ae4841d34eaa012e1b9a19e9b42b5e59b",
      "a61661497f61933afc8fcc1f4b4a0997eae3c4c85327c842738f1acb4b7f6418",
    ],
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
  },
  "whatsapp-linked-device": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "4c58bd39ab0971764bc1361a8093f5965146c81e9be6785eb2c6c324765518c3",
    legacyCurrentReadImplementationSha256: [],
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
  },
  "x-official": {
    schemaVersion: 1,
    pluginVersion: "1.0.0",
    implementationSha256: "b861f63def7aec7c0a90415df4c3bc1b6dc9eb9724d08c90dffa23a9482066cd",
    legacyCurrentReadImplementationSha256: [],
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
  },
  "x-web": {
    schemaVersion: 1,
    pluginVersion: "1.1.0",
    implementationSha256: "54589eaf65c7de95442dcff6a81327d0a32ec38f58560769e7b807519db10eeb",
    legacyCurrentReadImplementationSha256: [],
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
  },
  "youtube-web": {
    schemaVersion: 1,
    pluginVersion: "1.2.0",
    implementationSha256: "4d38cceaf871d6885abf76790b3d47b1e77b8b35dbb94bf5411d86f60202acb4",
    legacyCurrentReadImplementationSha256: [
      "2c73bbfcb49ba86a7dec8b08d62b87c98c234545d8a1fd93cf02f03868dced34",
      "324abc5f2776c5dc16b9f42f65c20d9781ffc3925ba9f80ca098de45e8d29407",
      "e7d4f87718ebfd9e499d5a8a939acaca2f73c2bd78388e360419f9ab098a5cb0",
    ],
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
  },
} as const satisfies Readonly<Record<string, ReviewedBuiltInContractIdentityV1>>);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAXIMUM_LATER_CURRENT_IDENTITIES = 10;

for (const [pluginId, identity] of Object.entries(identities)) {
  if (!SHA256_PATTERN.test(identity.implementationSha256)) {
    throw new Error(`${pluginId} current contract identity is not one lowercase SHA-256`);
  }
  if (
    identity.legacyCurrentReadImplementationSha256.length
      > MAXIMUM_LATER_CURRENT_IDENTITIES
  ) {
    throw new Error(`${pluginId} has too many later current contract identities`);
  }
  const olderIdentities = [
    ...(identity.legacyReadImplementationSha256 === null
      ? []
      : Object.values(identity.legacyReadImplementationSha256)),
    ...(identity.legacyE71ReadImplementationSha256 === null
      ? []
      : Object.values(identity.legacyE71ReadImplementationSha256)),
  ];
  const reviewedIdentities: string[] = [
    identity.implementationSha256,
    ...olderIdentities,
  ];
  for (const value of identity.legacyCurrentReadImplementationSha256) {
    if (!SHA256_PATTERN.test(value)) {
      throw new Error(`${pluginId} later current contract identity is not one lowercase SHA-256`);
    }
    if (reviewedIdentities.includes(value)) {
      throw new Error(`${pluginId} later current contract identity is duplicated`);
    }
    reviewedIdentities.push(value);
  }
  Object.freeze(identity.legacyCurrentReadImplementationSha256);
  if (identity.legacyReadImplementationSha256 !== null) {
    Object.freeze(identity.legacyReadImplementationSha256);
  }
  if (identity.legacyE71ReadImplementationSha256 !== null) {
    Object.freeze(identity.legacyE71ReadImplementationSha256);
  }
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
