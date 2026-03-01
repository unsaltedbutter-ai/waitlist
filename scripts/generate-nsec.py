import ecdsa
import binascii

def bech32_polymod(values):
    GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ v
        for i in range(5):
            if (b >> i) & 1:
                chk ^= GEN[i]
    return chk

def bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]

def bech32_create_checksum(hrp, data):
    values = bech32_hrp_expand(hrp) + data
    mod = bech32_polymod(values + [0]*6) ^ 1
    return [(mod >> 5*(5-i)) & 31 for i in range(6)]

def bech32_encode(hrp, data):
    CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
    combined = data + bech32_create_checksum(hrp, data)
    return hrp + '1' + ''.join(CHARSET[d] for d in combined)

def convertbits(data, frombits, tobits, pad=True):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    max_acc = (1 << (frombits + tobits - 1)) - 1
    for value in data:
        acc = ((acc << frombits) | value) & max_acc
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad and bits:
        ret.append((acc << (tobits - bits)) & maxv)
    return ret

# Generate key
sk = ecdsa.SigningKey.generate(curve=ecdsa.SECP256k1)
priv_hex = sk.to_string().hex()
pub_hex = sk.verifying_key.to_string("compressed").hex()

# Encode
nsec = bech32_encode('nsec', convertbits(binascii.unhexlify(priv_hex), 8, 5))
npub = bech32_encode('npub', convertbits(binascii.unhexlify(pub_hex), 8, 5))

print(nsec)
print(npub)
