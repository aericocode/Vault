# 7-Zip 26.06, shipped with Vault

Share privately (lib/share/) packs the picked files into a password-protected
7z archive with these programs. They are shipped with Vault, not downloaded
when Vault runs, and they are the copies Vault uses first (see
lib/share/sevenzip.js).

| Platform  | File                  | From                         |
|-----------|-----------------------|------------------------------|
| Windows   | `win-x64/7za.exe`     | 7-Zip Extra (standalone)     |
| Linux x64 | `linux-x64/7zzs`      | 7-Zip for Linux (static)     |

Each folder holds the `License.txt` that came with that download. 7-Zip is
by Igor Pavlov, https://www.7-zip.org/. It is free software under the GNU
LGPL (with BSD 3-clause and BSD 2-clause parts, and for the Linux program
the unRAR license restriction), see the License.txt files and
player-lib/THIRD-PARTY.txt. The source code is at
https://www.7-zip.org/download.html and https://github.com/ip7z/7zip.

## Where they came from

Version 26.06, both archives linked from https://www.7-zip.org/download.html:

| Archive | SHA-256 of the downloaded archive |
|---------|-----------------------------------|
| https://github.com/ip7z/7zip/releases/download/26.06/7z2606-extra.7z | `396c180f12d2247c24b0b1fcd482c6fc2a2700f61211ffede1061dd971f5e104` |
| https://github.com/ip7z/7zip/releases/download/26.06/7z2606-linux-x64.tar.xz | `2b539cf067b2ad48e1baa5093dbaa8818b73542d1222a0ffde9dc5f2922ea62e` |

`7za.exe` is the x64 build from 7z2606-extra.7z (it reports itself as
"7-Zip (a) 26.06 (x64)"). `7zzs` is the
statically linked program from 7z2606-linux-x64.tar.xz; it is shipped
instead of `7zz` because it needs no libstdc++ or other shared library on
the user's system, only the Linux kernel.

## SHA-256 of the shipped programs

| File | SHA-256 |
|------|---------|
| `win-x64/7za.exe` | `dd3757f31c97e33776f2590317d4fb12f2da075db3dbb1e3f94d0f2a01d84ffa` |
| `linux-x64/7zzs`  | `0b58a64e71ebdf53751cd954cad1cc552c6a11ef51336bee6acafbdc54c28c1f` |

The same values are in `SHA256SUMS` (check with `sha256sum -c SHA256SUMS` in
this folder). `npm run build:exe` refuses to build when a program does not
match, and test/share-vendor.test.js checks them, this README and the run
permission of `7zzs` in git.

## Updating

1. Download the new `7z<ver>-extra.7z` and `7z<ver>-linux-x64.tar.xz` from
   https://www.7-zip.org/download.html and note their SHA-256.
2. Replace `win-x64/7za.exe` (x64, from the extra archive) and
   `linux-x64/7zzs` and both `License.txt` files.
3. Update `SHA256SUMS` and the tables above.
4. Keep the run permission on the Linux program:
   `git add --chmod=+x vendor/7zip/linux-x64/7zzs`.
5. Run test/share-pack.test.js on Windows and Linux: the password must still
   be read from standard input (see lib/share/sevenzip.js).
