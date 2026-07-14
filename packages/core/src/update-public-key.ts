// Ed25519 public key used to verify Bean update releases before installing them (see
// docs/superpowers/specs/2026-07-14-manual-update-check-design.md). Public keys are not
// secret — they ship inside the app so it can verify signatures the private key produced.
//
// PLACEHOLDER: this is a throwaway keypair generated during development. Replace it with a
// real, maintainer-generated public key before cutting the first real signed release — see
// .memory/project-manual-update-check.md for the one-time setup steps. The matching private
// key for THIS placeholder was never stored anywhere and cannot sign real releases.
export const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8LwtsND66zxC/IHQbGiErhdHrhOd8xxjNlYJw0PafjM=
-----END PUBLIC KEY-----
`;
