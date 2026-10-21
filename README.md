# Kiwi TCMS Connector untuk VS Code

> 📖 **Panduan pemakaian lengkap: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)** (bisa dibuka di VS Code lewat **Kiwi: Open User Guide**).

Kelola test case dan test run [Kiwi TCMS](https://kiwitcms.org) langsung dari VS Code, hubungkan (mapping) test case ke kode automation kamu, lalu jalankan test dan laporkan hasilnya tanpa membuka web Kiwi.

## Fitur

| Fitur | Keterangan |
|---|---|
| **Sign in** | Login lewat JSON-RPC Kiwi (`/json-rpc/`). Password disimpan di Secret Storage VS Code, tidak di settings. HTTPS tidak aman (self-signed, CA internal, URL berupa IP) bisa di-skip: kalau sertifikat ditolak, extension menawarkan tombol **Skip Certificate Verification** lalu otomatis mengaktifkan `kiwi.allowSelfSignedCertificate`. |
| **Tree view: Test Runs** | Daftar test run yang belum selesai beserta execution dan statusnya. Bisa Run / Pass / Fail langsung dari tree. |
| **Tree view: Test Plans** | Daftar test plan dan test case-nya. Ikon menunjukkan mana yang sudah **mapped** ke kode, mana yang automated tapi belum ada mapping-nya. |
| **Active test run** | Pilih satu run sebagai "active run" (terlihat di status bar). Semua hasil eksekusi dari editor dilaporkan ke run ini. |
| **Mapping via marker** | Cukup tulis ID di kode: `# kiwi: 123`, `@pytest.mark.kiwi(123)`, `// kiwi: 123`, tag Robot `TC-123`, tag Gherkin `@TC-123`. Polanya bisa diubah. |
| **CodeLens & hover** | Di atas tiap marker muncul: summary case · status di active run · `Run` · `Pass` · `Fail`. Ctrl+klik marker untuk membuka case di web. |
| **Run test case** | Menjalankan command framework kamu (sebagai VS Code Task) dengan variabel `${caseId}`, `${runId}`, `${file}`, `${testName}`, dll. Hasil otomatis dilaporkan dari exit code. |
| **Run seluruh test run** | Pilih case automated/mapped di run (yang belum PASSED terpilih otomatis) lalu jalankan satu per satu atau sekaligus (batch). |
| **Link / buat test case dari kode** | Taruh kursor di test → *Link Test to Existing Test Case* (cari case berdasarkan ID atau summary) atau *Create Test Case from Test at Cursor* (buat case baru di Kiwi + sisipkan marker). |
| **Buat test run** | Dari plan: pilih build (atau buat baru), pilih case, lalu run langsung jadi active run. |
| **Mapping report & validasi** | Report per plan: berapa persen case sudah mapped, case automated yang belum mapped, marker yang menunjuk ID yang tidak ada. Marker dengan ID tidak valid juga muncul di panel Problems. |

## Mulai cepat

1. `npm install`, lalu tekan **F5** di VS Code (membuka Extension Development Host). Atau buat paket dengan `npm run package` lalu install file `.vsix` (*Extensions → … → Install from VSIX*).
2. Buka Command Palette → **Kiwi: Sign In** → isi URL, username, password.
3. Atur cara menjalankan test di framework kamu, contoh di `.vscode/settings.json` project test:

```jsonc
{
  "kiwi.product": "MyProduct",

  // Satu test case. Contoh untuk runner custom yang memakai ID:
  "kiwi.run.command": "python run.py --run-id ${runId} --case-id ${caseId}",

  // (opsional) beberapa case sekaligus, misalnya satu test run:
  "kiwi.run.batchCommand": "python run.py --run-id ${runId} --case-ids ${caseIds}",

  // exitCode = extension yang set PASSED/FAILED, none = framework kamu sendiri yang lapor ke Kiwi
  "kiwi.run.reportResult": "exitCode"
}
```

4. Pilih active run: klik item **Kiwi** di status bar, atau ⭐ di view *Test Runs*.
5. Buka file test, lihat CodeLens di atas marker, klik **Run**.

Command yang dipakai bergantung pada apakah case itu ada di active run:

| Setting | Dipakai saat |
|---|---|
| `kiwi.run.command` | case ada di active run (hasil dilaporkan ke run tsb) |
| `kiwi.run.commandWithoutRun` | case tidak ada di active run / belum ada active run (jalan lokal saja). Fallback ke `kiwi.run.command` |
| `kiwi.run.batchCommand` | beberapa case sekaligus (per file / per test run) |
| `kiwi.run.batchCommandWithoutRun` | batch yang tidak satu pun case-nya ada di active run. Fallback ke `kiwi.run.batchCommand` |

Kalau framework melapor sendiri (`kiwi.run.reportResult: "none"`), extension hanya men-set RUNNING sebelum test jalan, lalu mengembalikan status sebelumnya untuk execution yang tidak mendapat hasil (test di-skip, di-deselect, atau crash).

## Variabel untuk command

| Variabel | Isi |
|---|---|
| `${caseId}` | ID test case (single run) |
| `${caseIds}` / `${caseIdsSpace}` | Semua ID, dipisah koma / spasi (batch) |
| `${runId}`, `${planId}`, `${buildId}` | Dari active test run |
| `${executionId}` | ID TestExecution case tsb di active run |
| `${file}`, `${relativeFile}`, `${fileDirname}`, `${fileBasename}`, `${fileBasenameNoExtension}`, `${line}` | Lokasi marker |
| `${testName}`, `${testClass}` | Nama test/class yang terdeteksi di dekat marker |
| `${pytestNodeId}` / `${pytestNodeIds}` | `tests/test_a.py::TestX::test_y`, atau `tests/test_a.py::TestX` kalau marker di class (single / batch, batch sudah dikutip) |
| `${files}` | File yang ter-mapping, dikutip & dipisah spasi (batch) |
| `${summary}`, `${workspaceFolder}`, `${env:NAMA}` | — |

Kalau variabel yang dipakai tidak tersedia (misalnya `${runId}` padahal belum ada active run), test tidak dijalankan dan muncul pesan yang menjelaskan alasannya.

Environment variable yang juga di-set: `KIWI_URL`, `KIWI_RUN_ID`, `KIWI_CASE_ID`, `KIWI_CASE_IDS`, `KIWI_EXECUTION_ID`, `KIWI_PLAN_ID`, `KIWI_BUILD_ID`, `KIWI_TEST_FILE`, `KIWI_TEST_NAME`, serta `TCMS_RUN_ID` dan `TCMS_PLAN_ID`, yang dibaca plugin resmi Kiwi (`tcms-api`, kiwitcms-pytest-plugin, robotframework plugin, dll.) supaya hasil masuk ke run yang sama.

### Contoh: pytest plugin dengan `@pytest.mark.tcms(case_id=N)` dan `--kiwi-run-id`

Untuk framework yang memetakan test lewat `@pytest.mark.tcms(case_id=N)` (bisa di level class) dan melapor sendiri ke Kiwi dengan `--kiwi-run-id=N`:

```jsonc
{
  "kiwi.allowSelfSignedCertificate": true,
  // hanya marker tcms yang dianggap mapping (hindari "TC-123" di docstring/komentar)
  "kiwi.mapping.patterns": ["\\btcms\\(\\s*case_id\\s*=\\s*(\\d+)\\s*\\)"],
  "kiwi.mapping.include": "tests/**/*.py",
  "kiwi.mapping.insertTemplates": { "python": "@pytest.mark.tcms(case_id=${id})" },

  // --kiwi-no-block: jangan tandai case lain di run sebagai BLOCKED
  "kiwi.run.command": "venv\\Scripts\\python.exe -m pytest \"${pytestNodeId}\" --kiwi-run-id=${runId} --kiwi-no-block",
  "kiwi.run.batchCommand": "venv\\Scripts\\python.exe -m pytest ${pytestNodeIds} --kiwi-run-id=${runId} --kiwi-no-block",
  "kiwi.run.commandWithoutRun": "venv\\Scripts\\python.exe -m pytest \"${pytestNodeId}\"",
  "kiwi.run.batchCommandWithoutRun": "venv\\Scripts\\python.exe -m pytest ${pytestNodeIds}",
  "kiwi.run.reportResult": "none"
}
```

Marker di level class menghasilkan `${pytestNodeId}` = `tests/x/test_a.py::TestClass` (semua method di class ikut jalan). Kalau satu case di-mapping ke beberapa test, batch run menjalankan semuanya.

### Contoh per framework

```jsonc
// pytest
"kiwi.run.command": "pytest \"${pytestNodeId}\"",
"kiwi.run.batchCommand": "pytest ${pytestNodeIds}",

// Robot Framework (marker = tag TC-123)
"kiwi.run.command": "robot --include TC-${caseId} tests",

// Maven / JUnit
"kiwi.run.command": "mvn -q test -Dtest=${testClass}#${testName}",

// Cucumber (marker = tag @TC-123)
"kiwi.run.command": "npx cucumber-js --tags @TC-${caseId}",

// Playwright / Jest (marker di judul test, mis. test('TC-123 login'))
"kiwi.run.command": "npx playwright test -g \"TC-${caseId}\""
```

## Format marker

Pola default (case-insensitive, bisa diganti lewat `kiwi.mapping.patterns`):

```python
@pytest.mark.tcms(case_id=123)   # pytest marker (di class atau function)
# kiwi: 123                      # komentar (bisa juga "kiwi=123", "kiwi: 1, 2")
@pytest.mark.kiwi(123)           # decorator / annotation: kiwi(123), @Kiwi(1, 2)
def test_login(): ...
```
```robot
Valid Login
    [Tags]    smoke    TC-123     # TC-123 atau KIWI-123
```

Satu test bisa punya beberapa ID, dan satu ID bisa di-mapping ke beberapa test. Yang di-scan hanya file yang cocok dengan `kiwi.mapping.include` (exclude: `kiwi.mapping.exclude`).

Marker yang disisipkan otomatis per bahasa bisa diatur, contohnya:

```jsonc
"kiwi.mapping.insertTemplates": { "python": "@pytest.mark.kiwi(${id})" }
```

## Perintah

Semua ada di Command Palette dengan prefix **Kiwi:**. Yang paling sering dipakai:

- **Kiwi: Find Test Case…** (`Ctrl+Alt+K`): cari case berdasarkan ID/summary, lalu go to code / run / set status / link / buka di web
- **Kiwi: Run Test Case**: menjalankan test di posisi kursor
- **Kiwi: Run Kiwi Test Cases in Current File**
- **Kiwi: Run Automated Cases of Test Run…**
- **Kiwi: Mark as Passed / Mark as Failed / Set Execution Status…**
- **Kiwi: Link Test to Existing Test Case…** / **Create Test Case from Test at Cursor…**
- **Kiwi: Create Test Run…**, **Kiwi: Select Active Test Run**
- **Kiwi: Show Mapping Report…**

## Pengembangan

```bash
npm install
npm run compile      # atau: npm run watch
npm test             # unit test (parser marker, deteksi nama test, template, JSON-RPC client dengan mock server)
npm run package      # membuat .vsix
```

Struktur:

```
src/
  extension.ts        wiring & lifecycle
  session.ts          login, secret storage, status eksekusi
  commands.ts         semua command & picker
  runner.ts           eksekusi test via VS Code Tasks + pelaporan hasil
  kiwi/               JSON-RPC client & tipe data
  mapping/            scan marker, deteksi nama test, sisip marker
  state/              active run & cache test case
  views/              tree view, CodeLens/hover/link, dokumen detail, status bar
```

Kompatibel dengan Kiwi TCMS 11+ (API `TestExecution`, `Build` per version).
