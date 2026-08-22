# regotty-distributor

CSV → cover üret → risk/kalite geçidi → 6 versiyon (MP3 320/44.1) → besteci (Spotify) →
kapak seç → **RouteNote'a otomatik yükle** (9 mağaza) → (isteğe bağlı) yayına gönder.

Login gerçek Chrome + CapSolver ile otomatik yapılır. Daemon günde **günlük hedef** kadar release'i sırayla (aralıksız) üretir, hedef dolunca ertesi güne kadar bekler, kuyruk bitene dek sürer (hedef panelden / config'den ayarlanır). Panelden **N release** (belirttiğin sayı kadar, sonra durur) da başlatılabilir.

---

## 1) Gereksinimler (bir kez)

- **Node.js** (v18+) ve **ffmpeg** PATH'te (`ffmpeg -version` çalışmalı).
- **Google Chrome** kurulu (login bunu kullanır — bot korumasını geçmek için gerçek tarayıcı şart).
- **regotty / ACE-Step backend'i çalışır durumda** (cover şarkıları bunun üzerinden üretilir).
- **CapSolver** hesabı + API key (reCAPTCHA çözümü için).
- Bağımlılıklar: klasörde `npm install` (playwright kurulu gelir; ayrı tarayıcı indirmesi gerekmez, sistem Chrome'u kullanır).

---

## 2) ŞUNLARI DOLDUR — dolunca başlamaya hazır

### 📄 `config/config.json`  ← en önemlisi
`config/config.example.json`'ı **`config.json` olarak kopyala** ve `<...>` yerlerini doldur:

| Alan | Ne yazılacak |
|---|---|
| `regotty.token` | ACE-Step/regotty backend JWT token'ın |
| `routenote.uid` | RouteNote kullanıcı ID'n |
| `routenote.login.username` / `password` | RouteNote giriş bilgilerin |
| `routenote.captcha.apiKey` | CapSolver API key'in |
| `routenote.label` / `pLine` | Label adın (℗ satırı) |
| `spotifyCredits.tokenCachePath` | spotify-metadata-tools token cache yolu |
| `routenote.autoSubmit` | `false` = taslak bırak (güvenli) · `true` = otomatik yayına gönder |

### 📄 `input/input.csv`  — cover'lanacak şarkılar (sırayla işlenir)
```
artist,song,url,instrumental
Justin Bieber,Beauty And A Beat,,
The Weeknd,Blinding Lights,https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b,
Mareux,The Perfect Girl,,yes
```
`artist` = **orijinal sanatçının sahne adı** (© C-line'a bu girilir). **Mashup** ise iki isim virgülle:
`"The Weeknd, Michael Jackson",Timeless x Billie Jean`

`url` (opsiyonel, 3. kolon) = kaynak şarkının **Spotify linki**. Girilirse besteci + explicit
bilgisi **tam o şarkıdan** (spclient — rate-limit yok) çekilir. Boşsa isimle aranır (public API).
**Panelde** Kuyruk sekmesine link yapıştırıp **Çek**'e basınca sanatçı/şarkı/link otomatik dolar.

`instrumental` (opsiyonel, 4. kolon — panelde **🎹 Enst.** tiki) = `yes` ise o şarkının
**instrumental sürümü** üretilir: backend YouTube'da **"\<şarkı\> instrumental"** kaynağını bulur
ve ACE-Step'i sözsüz (`--instrumental`) çalıştırır — ayrı vokal-ayırma gerekmez. 6 versiyon
`<şarkı> - Instrumental`, `... - Instrumental - Slowed` diye isimlenir. Instrumental'da vokal
kontrolü atlanır ve explicit `Not Explicit` olur.

### 📄 `artists/artists.csv`  — senin dağıtım profillerin (sırayla döner)
```
artist_name,spotify_url
Arelio,https://open.spotify.com/artist/4ncJbWxCwsZ2YMjc1mSN1l
```

### 🖼️ `covers/`  klasörü — kapak görselleri
- **3000×3000 JPG/PNG**, RGB (CMYK olmaz). Her release **bir kapak** kullanır ve kullanınca **silinir**.
- Yeterince kapak koy (release sayısı kadar). Alfabetik sırayla tüketilir.

---

## 3) Çalıştır

### En kolay: `start.bat`'a çift tıkla
İlk çalıştırmada gerekirse `npm install` yapar, `config.json` yoksa örnekten oluşturur, paneli başlatır ve tarayıcıyı açar.

### Arayüz (önerilen) — her şeyi buradan yönet
```
npm run panel
```
→ tarayıcıda **http://localhost:4599**. Kuyruğu/sanatçıları/config'i düzenle, kapak yükle,
**RouteNote'a giriş yap**, **N release** (sayıyı gir → sırayla üretir, biter) ya da **daemon** (günlük hedef kadar sırayla, ertesi gün devam) başlat, canlı logları izle, autoSubmit'i aç/kapa.

### Komut satırı (alternatif)
```
npm run login                 # RouteNote'a giriş (Chrome açılır, captcha otomatik çözülür)
npm start                     # 1 release üret → TASLAK
npm start -- --count 9        # 9 release SIRAYLA üret → sonra durur ("işlem bitti")
npm start -- --count 9 --publish   # 9 release sırayla → her birini YAYINLA, sonra durur
npm run daemon                # günlük hedef kadar sırayla üret, sonra ertesi gün; kuyruk bitene dek (taslak)
npm run daemon -- --publish   # ... her birini otomatik yayınla
```
> `--publish` yoksa release **taslak** kalır (RouteNote'ta kontrol edip elle "Complete Release" diyebilirsin).
> `config.routenote.autoSubmit: true` yaparsan `--publish` olmadan da otomatik yayınlar.

---

## Akış (release başına)
1. `input/input.csv`'den sıradaki şarkı + `artists/artists.csv`'den sıradaki profil.
2. regotty backend cover şarkıyı üretir.
3. **Geçit:** risk skoru **pencerede** (`minRiskScore ≤ risk < maxRiskScore`, örn. 20–35) + **kalite** + **vokal/lyrics anlaşılırlığı**. Retention'ı **0.19→0.30** tarayarak (düşükten başlar, risk düşükse artırır) pencereye sokar; vokal boğuk/sözler yutuluyorsa yeni take dener.
4. 6 versiyon render (Original / Slowed / Ultra Slowed / Slowed but Muffled / Sped Up / 8D Audio).
5. Besteci Spotify credits'ten çekilir; `covers/`'dan bir kapak tüketilir.
6. RouteNote'a yüklenir: albüm → 6 parça → metadata → kapak → 9 mağaza → (autoSubmit ise) yayına gönder.
7. `output/<...>/release.json` yazılır; ilerleme `state/rotation.json`'da tutulur (kaldığı yerden devam eder).

## Dağıtılan mağazalar (9)
Spotify · Deezer · TIDAL · Nuuday · Anghami · Pandora · iHeartRadio · Saavn · KKBOX

## Vokal / lyrics kontrolü
Cover'ın vokali mikste **önde ve anlaşılır** mı diye bakar. Üç katman (hepsi opsiyoneli graceful):

1. **ffmpeg muffle** (her zaman) — yüksek frekans düşüşü → boğuk/dull vokal.
2. **Demucs** (önerilen — asıl güvence) — vokal stem'ini beat'ten **ayırıp seviyesini ölçer**: vokal beatin altında/dipte mi? Whisper dipteki vokali **deşifre edebildiği (hatta lyrics uydurduğu)** için tek başına yetmez; "vokal dipte geliyor" sorununu yakalayan tek kesin ölçüm budur.
   ```
   pip install demucs
   ```
   Kuruluysa otomatik (`vocalCheck.demucsCmd: "auto"`). `minVocalRatioDb` (vokal−beat dB farkı) bunun altındaysa "dipte" sayılır (ilk çalıştırmada loglanan değere göre ayarlanır). Hız için 40 sn'lik kesitte çalışır.
3. **Whisper** (kelime anlaşılırlığı) — sözler yutuluyor mu, net mi:
   ```
   pip install -U openai-whisper
   ```
   `--temperature 0` ile deterministik çalışır; kelime/dk, no-speech, güven, tekrar metriklerine bakar.

Eşikler `config.vocalCheck`'ten. Hiçbir ML aracı kurulu değilse sadece muffle çalışır (pipeline bloklanmaz ama dipteki vokali yakalayamaz → demucs şart).

## Notlar
- Kapak dosya adları temiz olmalı (script zaten `cover.jpg` olarak yükler — RouteNote bozuk adları sessizce reddeder).
- İlk çalıştırmada login için Chrome penceresi kısa süre açılır; oturum `state/`'e kaydedilip tekrar kullanılır.
- `config.json`, `state/`, `output/`, `covers/*` gitignore'da — gizli/kişisel veriler paylaşılmaz.
