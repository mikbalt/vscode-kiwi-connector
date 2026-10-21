# User Guide: Kiwi TCMS Connector

Panduan memakai extension Kiwi TCMS di VS Code untuk mengelola test run, menghubungkan test case ke kode automation, menjalankan test, dan melaporkan hasil tanpa membuka web Kiwi.

> Guide ini bisa dibuka kapan saja dari VS Code: tombol **?** di sidebar Kiwi, atau Command Palette → **Kiwi: Open User Guide**.

## Daftar isi

1. [Konsep singkat](#1-konsep-singkat)
2. [Instalasi](#2-instalasi)
3. [Sign in](#3-sign-in)
4. [Mengenal tampilan](#4-mengenal-tampilan)
5. [Membuat test run](#5-membuat-test-run)
6. [Memilih active test run](#6-memilih-active-test-run)
7. [Menjalankan test](#7-menjalankan-test)
8. [Mengisi status secara manual](#8-mengisi-status-secara-manual)
9. [Menghubungkan test dengan test case (mapping)](#9-menghubungkan-test-dengan-test-case-mapping)
10. [Mencari test case](#10-mencari-test-case)
11. [Mapping report](#11-mapping-report)
12. [Di mana melihat hasil](#12-di-mana-melihat-hasil)
13. [Konfigurasi](#13-konfigurasi)
14. [Troubleshooting](#14-troubleshooting)
15. [Ringkasan perintah](#15-ringkasan-perintah)

---

## 1. Konsep singkat

| Istilah | Artinya di extension ini |
|---|---|
| **Test plan** | Kumpulan test case di Kiwi. Di view *Test Plans*, buka plan untuk melihat case-nya. |
| **Test run** | Satu sesi eksekusi dari sebuah plan + build. Setiap case di run punya **execution** dengan status (IDLE, RUNNING, PASSED, FAILED, BLOCKED, …). |
| **Active test run** | Satu run yang kamu pilih sebagai tujuan pelaporan. Semua eksekusi dari VS Code dilaporkan ke run ini. Terlihat di status bar. |
| **Marker** | Penanda ID test case di kode, misalnya `@pytest.mark.tcms(case_id=37509)`. Dari marker inilah extension tahu test mana milik case mana. |
| **Mapped** | Test case yang sudah punya marker di kode workspace. |

Alur kerja harian biasanya: **buat/pilih test run → jalankan test dari editor → status di Kiwi ter-update otomatis**.

## 2. Instalasi

1. Dapatkan file `kiwi-tcms-connector-<versi>.vsix`.
2. VS Code → Extensions (`Ctrl+Shift+X`) → menu **…** (kanan atas) → **Install from VSIX…** → pilih file.
3. Jalankan `Ctrl+Shift+P` → **Developer: Reload Window**.

> Saat meng-update ke versi baru, selalu **Reload Window** di setiap window VS Code yang terbuka. Tanpa reload, VS Code tetap menjalankan versi lama.

Setelah terpasang, ikon Kiwi muncul di Activity Bar (sidebar kiri).

## 3. Sign in

1. Klik ikon Kiwi di Activity Bar → **Sign In**, atau klik **Kiwi: Sign in** di status bar.
2. Isi **URL** Kiwi (misalnya `https://kiwi.perusahaan.com`; URL yang berakhiran `/xml-rpc/` atau `/json-rpc/` juga diterima), **username**, lalu **password**.

- Password disimpan di secret storage VS Code (bukan di file settings). Setelah sign in sekali, extension login otomatis saat VS Code dibuka.
- **Server dengan sertifikat tidak aman** (self-signed, CA internal, atau diakses lewat IP): muncul dialog *"The TLS certificate … is not trusted"*. Klik **Skip Certificate Verification** untuk tetap terhubung. Pilihan ini disimpan di setting `kiwi.allowSelfSignedCertificate`. Lakukan hanya untuk server internal yang kamu percaya.
- Untuk keluar: Command Palette → **Kiwi: Sign Out**.

## 4. Mengenal tampilan

### Status bar (bawah kiri)

| Tampilan | Arti | Klik untuk |
|---|---|---|
| `Kiwi: Sign in` | Belum login | Sign in |
| `Kiwi: no active run` | Login, belum ada active run | Memilih active run |
| `Run #45 12/30` | Active run #45, 12 dari 30 case sudah punya hasil | Mengganti active run |

Arahkan mouse ke item ini untuk melihat ringkasan passed / failed / remaining.

### View *Test Runs*

Menampilkan test run yang belum selesai (yang terbaru di atas). Run yang aktif ditandai ⭐.

- **Tombol di judul view:** ➕ Create Test Run · ☆ Select Active Test Run · ▶▶ Run automated cases of active run · ? User guide · ⟳ Refresh
- **Baris run:** ▶▶ jalankan case automated di run ini · ☆ jadikan active run · klik kanan → *Open in Kiwi TCMS*
- **Baris execution (case di dalam run):** ikon = status, keterangan = `STATUS · automated/manual · mapped`
  - tombol: ▶ Run · ✓ Mark as Passed · ✗ Mark as Failed
  - klik kanan: *Set Execution Status…*, *Go to Mapped Code*, *Show Test Case Details*, *Open in Kiwi TCMS*
  - klik baris: membuka kode test-nya (kalau sudah mapped) atau detail case

### View *Test Plans*

Menampilkan test plan aktif. Buka plan untuk melihat case-nya. Ikon case:

| Ikon | Arti |
|---|---|
| 🔗 hijau | Sudah mapped ke kode |
| ⚡ kuning (disconnect) | Automated tapi **belum** mapped. Perlu ditambahkan marker. |
| 👤 | Manual |

- **Tombol di judul view:** ➕ Create Test Run · 🔍 Find Test Case · ? · ⟳
- **Klik kanan plan:** *Create Test Run…*, *Show Mapping Report…*, *Open in Kiwi TCMS*
- **Klik kanan case:** *Run Test Case*, *Add to Active Test Run*, *Go to Mapped Code*, *Show Test Case Details*, *Open in Kiwi TCMS*

### Di editor

Di atas setiap marker (contoh `@pytest.mark.tcms(case_id=37509)`) muncul **CodeLens**:

```
🧪 TC-37509: [E2E][e-admin][Key Ceremony] Key ceremony FIPS mode | ✓ PASSED | ▶ Run | ✓ Pass | ✗ Fail
```

| Bagian | Klik untuk |
|---|---|
| `TC-xxxx: summary` | Membuka detail case (steps, status, lokasi kode) |
| status (`PASSED`, `IDLE`, …) | Mengganti status di active run. Hanya muncul kalau case ada di active run. |
| `▶ Run` | Menjalankan test ini |
| `✓ Pass` / `✗ Fail` | Mengisi status manual |
| `➕ Add to run` | Menambahkan case ke active run (muncul kalau case belum ada di run) |

Lainnya:
- **Hover** di marker: ringkasan case dan link aksi.
- **Ctrl+klik** marker: membuka case di web Kiwi.
- **Panel Problems**: peringatan untuk marker yang menunjuk ID case yang tidak ada di Kiwi.
- **Klik kanan di editor**: *Link Test to Existing Test Case…*, *Create Test Case from Test at Cursor…*, *Run Kiwi Test Cases in Current File*.

## 5. Membuat test run

Bisa dimulai dari tiga tempat:
- tombol ➕ di judul view **Test Runs** atau **Test Plans**
- klik kanan sebuah plan → **Create Test Run…** (langkah memilih plan dilewati)
- Command Palette → **Kiwi: Create Test Run…**

Langkah-langkahnya:

1. **Pilih test plan.** Plan yang terakhir dipakai muncul paling atas.
2. **Pilih build.** Daftar build aktif untuk versi produk plan tersebut. Kalau belum ada, pilih **➕ Create a new build…** lalu ketik namanya (misalnya `v1.0.7-rc2`).
3. **Pilih test case** yang masuk ke run. Ini multi-select: centang / hilangkan centang, ketik untuk memfilter. Case berstatus CONFIRMED sudah tercentang otomatis.
4. **Isi summary run.** Default: `<nama plan> — <build> — <tanggal>`.
5. Extension membuat run, menambahkan case-nya (progress terlihat di notifikasi), lalu **menjadikannya active run**.
6. Di notifikasi akhir, pilih **Run Automated Cases** untuk langsung mengeksekusi, atau **Open in Kiwi TCMS** untuk melihatnya di web.

Kamu sebagai user yang login menjadi *manager* dan *default tester* run tersebut.

**Menambah case ke run yang sudah ada:** klik kanan case di *Test Plans* → **Add to Active Test Run**, atau klik `➕ Add to run` di CodeLens.

## 6. Memilih active test run

Active run menentukan ke mana hasil dilaporkan. Pilih dengan salah satu cara berikut:
- klik item Kiwi di status bar
- ☆ di baris run pada view *Test Runs*
- Command Palette → **Kiwi: Select Active Test Run** (ketik untuk memfilter berdasarkan summary, plan, atau build)

Active run disimpan per workspace. Untuk melepasnya: **Kiwi: Clear Active Test Run**.

> Menjalankan test dari baris execution milik run lain otomatis menjadikan run itu active run, supaya hasilnya tidak salah alamat.

## 7. Menjalankan test

### Satu test

- `▶ Run` di CodeLens, atau
- ▶ di baris execution / case pada sidebar, atau
- taruh kursor di dalam test → Command Palette → **Kiwi: Run Test Case**

Yang terjadi:
1. Kalau case ada di active run, statusnya di-set **RUNNING**.
2. Command test dijalankan sebagai VS Code task di panel **Terminal**. Command-nya diatur di `kiwi.run.command` (lihat [Konfigurasi](#13-konfigurasi)).
3. Setelah selesai, hasil dilaporkan ke Kiwi. Tergantung setting, yang melapor bisa framework kamu sendiri atau extension (dari exit code). Sidebar, CodeLens, dan status bar ikut ter-refresh.

Kalau case **tidak ada** di active run (atau belum ada active run), test tetap dijalankan memakai `kiwi.run.commandWithoutRun` dan **tidak ada hasil yang dilaporkan**.

Kalau satu case di-mapping ke beberapa test, extension menanyakan test mana yang mau dijalankan.

### Banyak test sekaligus

| Cara | Yang dijalankan |
|---|---|
| ▶▶ di baris run / judul *Test Runs* (**Run Automated Cases of Test Run…**) | Pilih dari case automated/mapped di run. Case yang **belum PASSED** sudah tercentang. |
| Klik kanan editor → **Run Kiwi Test Cases in Current File** | Semua case yang punya marker di file itu |

Kalau `kiwi.run.batchCommand` diisi, semuanya dijalankan dalam satu command. Kalau tidak, dijalankan satu per satu dengan progress yang bisa dibatalkan.

### Menghentikan test

Hentikan task di panel Terminal (ikon 🗑 / `Ctrl+C`). Execution yang masih RUNNING dikembalikan ke status sebelumnya.

## 8. Mengisi status secara manual

Untuk case manual, atau saat kamu ingin mengoreksi hasil:
- `✓ Pass` / `✗ Fail` di CodeLens atau tombol di baris execution
- **Set Execution Status…** (klik kanan execution, atau klik status di CodeLens) untuk status lain: BLOCKED, WAIVED, ERROR, PAUSED, …

Untuk status negatif (FAILED, BLOCKED, ERROR), extension meminta **komentar opsional**. Tekan Enter untuk melewati, atau Escape untuk membatalkan.

## 9. Menghubungkan test dengan test case (mapping)

### Menghubungkan test ke case yang sudah ada

1. Buka file test, taruh kursor di test (class atau function).
2. Klik kanan → **Link Test to Existing Test Case…**
3. Ketik ID (`37509` atau `TC-37509`) atau minimal 3 huruf summary, lalu pilih case-nya.
4. Marker disisipkan di atas definisi test (di atas decorator yang sudah ada). Contoh untuk pytest: `@pytest.mark.tcms(case_id=37509)`.

### Membuat case baru dari test

1. Taruh kursor di test → klik kanan → **Create Test Case from Test at Cursor…**
2. **Summary** terisi otomatis dari `@allure.title(...)` kalau ada, atau dari nama test. Ubah bila perlu.
3. Pilih **test plan** tujuan.
4. Extension membuat case di Kiwi (automated, status sesuai `kiwi.newCase.status`), menambahkannya ke plan, lalu menyisipkan marker di kode.
5. Dari notifikasi, kamu bisa langsung **Add to Active Run**.

### Aturan marker

- Format marker mengikuti setting `kiwi.mapping.patterns`. Untuk framework pytest dengan `@pytest.mark.tcms(case_id=N)`, set hanya pola itu agar teks seperti "lihat TC-123" di komentar tidak dianggap mapping.
- Marker di atas **class** berarti seluruh class adalah test untuk case itu. Marker di atas **function** hanya berlaku untuk function itu.
- Satu case boleh di-mapping ke beberapa test, dan satu test boleh punya beberapa case.
- Mapping ter-update otomatis saat kamu mengetik atau menyimpan file.

## 10. Mencari test case

`Ctrl+Alt+K` (atau 🔍 di judul *Test Plans*, atau **Kiwi: Find Test Case…**)

Ketik ID atau sebagian summary, pilih case, lalu pilih aksinya: **Go to code**, **Run**, **Set status in active run**, **Add to active run**, **Link the test at the cursor to this case**, **Show details**, **Open in Kiwi TCMS**.

## 11. Mapping report

Klik kanan plan → **Show Mapping Report…** (atau ikon ☑ di baris plan).

Report berisi:
- persentase case di plan yang sudah mapped ke kode
- case **automated tapi belum mapped** (perlu ditambahkan marker)
- case manual yang ternyata sudah punya marker (mungkin perlu ditandai automated di Kiwi)
- marker di workspace yang menunjuk ID case yang tidak ada
- tabel case yang sudah mapped beserta lokasi kodenya (bisa diklik)

## 12. Di mana melihat hasil

| Tempat | Isi |
|---|---|
| Panel **Terminal**, tab task `TC-xxxxx` | Output lengkap test (misalnya pytest) |
| Panel **Output** → pilih **Kiwi TCMS** | Log extension: command yang dijalankan, exit code, status yang dikembalikan, error koneksi |
| View *Test Runs*, CodeLens, status bar | Status terbaru dari Kiwi |
| Web Kiwi | Status, komentar, dan lampiran yang dikirim framework |
| Folder evidence framework | Hasil Allure, screenshot, log (tergantung framework) |

## 13. Konfigurasi

Buka **File → Preferences → Settings** lalu cari `kiwi`, atau edit `.vscode/settings.json` di folder project test.

### Setting utama

| Setting | Fungsi |
|---|---|
| `kiwi.url`, `kiwi.username` | Diisi otomatis saat sign in |
| `kiwi.allowSelfSignedCertificate` | Skip verifikasi sertifikat HTTPS |
| `kiwi.product` | Hanya tampilkan plan/run dari produk ini |
| `kiwi.runs.show` | `active` (run yang belum selesai) atau `all` |
| `kiwi.mapping.patterns` | Regex untuk menemukan marker. Capture group pertama berisi ID. |
| `kiwi.mapping.include` / `exclude` | File yang di-scan |
| `kiwi.mapping.insertTemplates` | Teks marker yang disisipkan, per bahasa |
| `kiwi.run.command` | Command untuk 1 case yang **ada** di active run |
| `kiwi.run.commandWithoutRun` | Command untuk 1 case yang **tidak** ada di active run |
| `kiwi.run.batchCommand` / `batchCommandWithoutRun` | Command untuk banyak case sekaligus |
| `kiwi.run.reportResult` | `exitCode` (extension yang lapor dari exit code), `ask` (tanya setiap kali), `none` (framework yang lapor) |
| `kiwi.codeLens.enabled` | Menampilkan / menyembunyikan CodeLens |
| `kiwi.newCase.status` / `priority` / `category` | Default untuk case baru dari kode |

### Variabel dalam command

`${caseId}` `${caseIds}` `${runId}` `${executionId}` `${planId}` `${buildId}` `${file}` `${relativeFile}` `${line}` `${testName}` `${testClass}` `${pytestNodeId}` `${pytestNodeIds}` `${files}` `${summary}` `${workspaceFolder}` `${env:NAMA}`

Daftar lengkap dan artinya ada di README.

### Contoh: pytest dengan `@pytest.mark.tcms(case_id=N)` dan `--kiwi-run-id`

```jsonc
{
  "kiwi.allowSelfSignedCertificate": true,
  "kiwi.mapping.patterns": ["\\btcms\\(\\s*case_id\\s*=\\s*(\\d+)\\s*\\)"],
  "kiwi.mapping.include": "tests/**/*.py",
  "kiwi.mapping.insertTemplates": { "python": "@pytest.mark.tcms(case_id=${id})" },
  "kiwi.run.command": "venv\\Scripts\\python.exe -m pytest \"${pytestNodeId}\" --kiwi-run-id=${runId} --kiwi-no-block",
  "kiwi.run.batchCommand": "venv\\Scripts\\python.exe -m pytest ${pytestNodeIds} --kiwi-run-id=${runId} --kiwi-no-block",
  "kiwi.run.commandWithoutRun": "venv\\Scripts\\python.exe -m pytest \"${pytestNodeId}\"",
  "kiwi.run.batchCommandWithoutRun": "venv\\Scripts\\python.exe -m pytest ${pytestNodeIds}",
  "kiwi.run.reportResult": "none"
}
```

> ⚠️ Pada framework yang memakai `--kiwi-run-id`, **selalu sertakan `--kiwi-no-block`** saat menjalankan sebagian test. Tanpa itu, semua case lain di run yang tidak ikut dijalankan akan ditandai BLOCKED.

## 14. Troubleshooting

| Gejala | Solusi |
|---|---|
| `self-signed certificate` / `certificate is not trusted` | Klik **Skip Certificate Verification** di dialog, atau set `kiwi.allowSelfSignedCertificate: true`. Kalau masih error setelah update extension, lakukan **Developer: Reload Window**. |
| Perubahan / fitur baru tidak muncul setelah install VSIX | **Developer: Reload Window** di setiap window VS Code |
| Sidebar kosong / "Error: …" | Klik ⟳ Refresh. Cek panel Output → **Kiwi TCMS**. |
| Test run tidak muncul | Run yang sudah selesai disembunyikan. Set `kiwi.runs.show` ke `all`. Cek juga `kiwi.product`. |
| CodeLens tidak muncul | File harus cocok dengan `kiwi.mapping.include` dan marker cocok dengan `kiwi.mapping.patterns`. Cek juga `kiwi.codeLens.enabled`. |
| "Cannot run TC-x: ${runId} is not available" | Belum ada active run. Pilih dulu lewat status bar. |
| "… is not mapped to code in this workspace" | Tambahkan marker ke test (lihat [Mapping](#9-menghubungkan-test-dengan-test-case-mapping)). |
| Test jalan tapi status di Kiwi tidak berubah | Kalau `reportResult` = `none`, framework yang melapor. Cek output test di Terminal (koneksi Kiwi framework, kredensial di `.env`). Status yang tertinggal di RUNNING dikembalikan otomatis. |
| Test tidak jalan ("deselected" / "no tests collected") | Case tidak ada di run yang diberikan ke framework. Tambahkan case ke active run, atau periksa `kiwi.run.commandWithoutRun`. |
| Warning di Problems: "TC-x does not exist in Kiwi TCMS" | ID di marker salah, atau kamu tidak punya akses ke case itu. |

## 15. Ringkasan perintah

Semua perintah ada di Command Palette (`Ctrl+Shift+P`) dengan awalan **Kiwi:**.

| Perintah | Fungsi |
|---|---|
| Sign In / Sign Out | Login / logout |
| Refresh | Muat ulang data dari Kiwi dan scan ulang marker |
| Create Test Run… | Membuat run baru dari plan |
| Select Active Test Run / Clear Active Test Run | Mengatur tujuan pelaporan |
| Run Test Case | Menjalankan test di kursor / yang dipilih |
| Run Automated Cases of Test Run… | Menjalankan banyak case dari active run |
| Run Kiwi Test Cases in Current File | Menjalankan semua case di file aktif |
| Mark as Passed / Mark as Failed / Set Execution Status… | Mengisi status manual |
| Find Test Case… (`Ctrl+Alt+K`) | Mencari case dan memilih aksi |
| Link Test to Existing Test Case… | Menyisipkan marker untuk case yang ada |
| Create Test Case from Test at Cursor… | Membuat case baru dari test |
| Add to Active Test Run | Menambahkan case ke active run |
| Go to Mapped Code | Membuka lokasi test dari case |
| Show Test Case Details | Detail case (steps, status, lokasi kode) |
| Open in Kiwi TCMS | Membuka case / run / plan di browser |
| Show Mapping Report… | Laporan coverage mapping per plan |
| Open User Guide | Membuka guide ini |
