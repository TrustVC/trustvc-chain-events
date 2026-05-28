export const REGISTRY_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event PauseWithRemark(address account, bytes remark)',
  'event UnpauseWithRemark(address account, bytes remark)',
  'function titleEscrowFactory() view returns (address)',
];

export const FACTORY_ABI = [
  'event TitleEscrowCreated(address indexed titleEscrow, address indexed tokenRegistry, uint256 indexed tokenId)',
];

// V5 TitleEscrow ABI — sourced from @tradetrust-tt/token-registry-v5
export const ESCROW_ABI = [
  'event TokenReceived(address indexed beneficiary, address indexed holder, bool indexed isMinting, address registry, uint256 tokenId, bytes remark)',
  'event Nomination(address indexed prevNominee, address indexed nominee, address registry, uint256 tokenId, bytes remark)',
  'event BeneficiaryTransfer(address indexed fromBeneficiary, address indexed toBeneficiary, address registry, uint256 tokenId, bytes remark)',
  'event HolderTransfer(address indexed fromHolder, address indexed toHolder, address registry, uint256 tokenId, bytes remark)',
  'event ReturnToIssuer(address indexed caller, address registry, uint256 tokenId, bytes remark)',
  'event Shred(address registry, uint256 tokenId, bytes remark)',
  'event RejectTransferBeneficiary(address indexed fromBeneficiary, address indexed toBeneficiary, address registry, uint256 tokenId, bytes remark)',
  'event RejectTransferHolder(address indexed fromHolder, address indexed toHolder, address registry, uint256 tokenId, bytes remark)',
  'event RejectTransferOwners(address indexed fromBeneficiary, address indexed toBeneficiary, address indexed fromHolder, address toHolder, address registry, uint256 tokenId, bytes remark)',
];
