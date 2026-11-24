#!/bin/sh
# One-time: make the self-signed codesigning cert the Mac installer workflow signs Bean.app with
# (see scripts/after-sign.mjs). Keep the .p12 and its password backed up — a new cert changes
# Bean's designated requirement and resets every user's macOS privacy grants once more.
#
#   sh packages/app/scripts/make-signing-cert.sh <out-dir>
#
# Then store the two GitHub secrets it prints instructions for. Never commit the output.
set -eu
out=${1:?usage: make-signing-cert.sh <out-dir>}
mkdir -p "$out"
umask 077
cnf="$out/cert.cnf"
cat > "$cnf" <<'EOF'
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=Bean Self-Signed Code Signing
[v3]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
pass=$(openssl rand -hex 24)
openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$cnf" \
  -keyout "$out/key.pem" -out "$out/cert.pem" 2>/dev/null
# 3DES/SHA1 PKCS12: macOS `security import` rejects OpenSSL 3+'s AES/SHA256 default
# ("MAC verification failed … wrong password?").
openssl pkcs12 -export -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -inkey "$out/key.pem" -in "$out/cert.pem" -name "Bean Self-Signed Code Signing" -out "$out/bean-signing.p12" -passout "pass:$pass"
printf '%s' "$pass" > "$out/bean-signing.p12.password"
rm "$out/key.pem" "$cnf"

echo "Wrote $out/bean-signing.p12 (+ .password). Back both up, then:"
echo "  base64 -i '$out/bean-signing.p12' | gh secret set MAC_SIGN_P12"
echo "  gh secret set MAC_SIGN_P12_PASSWORD < '$out/bean-signing.p12.password'"
