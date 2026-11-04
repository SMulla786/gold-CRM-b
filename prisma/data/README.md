# Master data

## `lgd-districts.csv`: India states / UTs and districts

**Source.** The Local Government Directory (LGD), Government of India (Ministry of Panchayati Raj), is the official
master of administrative units: <https://lgdirectory.gov.in/downloadDirectory.do>, "All Districts of India".
The LGD site's own CSV download is unreliable, so this file is the LGD "districts" report as archived daily by
ramSeraph/opendata. That project republishes the LGD reports unmodified, with checksums:

| | |
|---|---|
| Release asset | <https://github.com/ramSeraph/opendata/releases/download/lgd-latest/districts.01Nov2026.csv.7z> |
| Index (lists today's file and checksums) | <https://ramseraph.github.io/opendata/lgd/data/metadata.json> (`datasets.districts`) |
| LGD observed on | 2026-11-01 |
| `.7z` SHA-256 | `43ee332566bf789f880a3615368ed7d14362950d788353ab0f71fa612b8b46fe` |
| CSV SHA-256 (this file, byte for byte) | `08ac67303317c0cd9b84becefadebca73209eefbf6f7e87a9876daff5dcb5f10` |
| Rows | 790 districts in 36 states / UTs |

Columns used: `State Name (In English)`, `District Code` (the LGD code, stored in `District.lgdCode`), and
`District Name(In English)`. `State.id` is the **GST** state code (`src/shared/geo.ts`), not the LGD state code.
The importer maps states by name (for example, Andhra Pradesh is LGD 28 but GST 37). All 36 names map today.
A new or renamed state makes the importer stop with an error instead of guessing.

**Loading** (`prisma/districts.ts`). The seed runs it, and so does `scripts/import-districts.ts`:

```sh
npx tsx --env-file=.env scripts/import-districts.ts           # dry run: what would change
npx tsx --env-file=.env scripts/import-districts.ts --apply   # write (one transaction)
```

The import is idempotent: a second `--apply` creates and updates nothing. A district is matched by LGD code, or, for
rows made before this import, by state and name ignoring case. A match is updated in place, so its id and every
branch, party, business or sign-up that references it stay as they are. Nothing is deleted. A district the source no
longer lists is kept and printed with its reference count, so an operator can decide what to do with it.

**Updating the dataset.**

1. Open `metadata.json` above. Under `datasets.districts`, the `manifest` URL gives `source.asset.browser_download_url`
   (the dated `.7z`), its `digest` and the `csv_sha256`.
2. Download the `.7z` and check its SHA-256 against `digest`. Extract it (`tar -xf` with bsdtar, or 7-Zip) and check the
   CSV against `csv_sha256`.
3. Replace `lgd-districts.csv` with the extracted file, byte for byte, and update the table above.
4. Run the dry run against a copy of the database and review the created, updated and kept lines, especially renames.
   Then back up and run `--apply`.
