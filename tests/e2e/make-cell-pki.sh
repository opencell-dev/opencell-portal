#!/bin/bash
# A throwaway PKI for the browser tests' portal (plan P3): a root and an
# intermediate in the Global Constraints' profile. Run by playwright.config.ts
# before the server starts; the keys live and die in the e2e directory.
set -euo pipefail
dir=$1
mkdir -p "$dir"
cd "$dir"
openssl ecparam -name prime256v1 -genkey -noout -out root.key 2>/dev/null
cat > root.cnf <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
O = OpenCell
CN = OpenCell Test Root
[root]
basicConstraints = critical, CA:TRUE, pathlen:1
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[ica]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
extendedKeyUsage = clientAuth
certificatePolicies = 2.25.39025894690731581968303886031091540846.1.3
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
openssl req -x509 -new -key root.key -sha256 -days 30 -config root.cnf -extensions root -out root.crt
openssl ecparam -name prime256v1 -genkey -noout -out ica.key 2>/dev/null
openssl req -new -key ica.key -subj '/O=OpenCell/CN=OpenCell Cell CA 1' -out ica.csr
openssl x509 -req -in ica.csr -CA root.crt -CAkey root.key -sha256 -days 30 -set_serial "0x$(openssl rand -hex 15)" -extfile root.cnf -extensions ica -out ica.crt 2>/dev/null
