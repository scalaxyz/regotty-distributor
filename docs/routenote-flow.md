# RouteNote yükleme akışı (capture'dan decode edildi)

API yok; bu akış giriş yapılmış bir tarayıcı oturumunun HTTP isteklerinden çıkarıldı.
Her POST **session cookie** (auth) ve **CSRF form token'ları** (`form_build_id`, `form_token`,
`form_id`) taşır — token'lar her adımda ilgili sayfa GET'lenip HTML formundan kazınmalı.

`{upc}` = create_album'dan dönen albüm id'si (ör. `5064091824117`).

## Adımlar
1. **`POST /rn/create_album`** — release oluştur.
   - `edit_album_info_release` = release başlığı
   - `album_save` = `Create Release`, `tersawsas` = `true`
   - `form_build_id`, `form_token`, `form_id=create_album_form`
   - → editalbum sayfasına yönlendirir; `{upc}` alınır.

2. **`POST /rn/spotify_uri.php`** — artist Spotify linkini bağla.
   - `uid`, `artist2` (artist adı), `upc`, `suri` (artist Spotify url'i — artists.csv)

3. **`POST /rn/editalbum/{upc}`** — albüm + metadata (form-urlencoded, en kapsamlı).
   - `edit_album_info_title`, `edit_album_info_artist`, `edit_album_info_language`
   - `p_spotify_artist_id/name/uri/followers/image` (Spotify'dan çekilir)
   - `edit_album_first_composer`, `edit_album_last_composer` (**orijinal besteci** — Spotify credits)
   - `composer_value`, `composer2_value`, `role=Composer`
   - `contributors_role=Producer`, `contributors_name` (kendi artist), `role=Producer`
   - `edit_album_info_genre`, `edit_album_info_sec_genre`
   - `cpy_year`, `cpy_name`, `edit_album_info_pcopyyear`, `edit_album_info_pcopyname`, `edit_album_info_label`
   - `edit_album_info_org_date` (yyyy/mm/dd), `edit_album_info_explicit`
   - `album_save=Save and Continue`, form token'ları (`form_id=editalbum_form`)

4. **`POST /rn/cloud_upload`** — upload oturumu başlat.
   - `remove_trackid=1`, `upc_nos=.../addaudiomp3/form/{upc}`, `sp_track=1`
   - → upload hash token'ı (`55673266a6a35083...`) döner.

5. Her track (6) için:
   - **`POST /rn/cloud_upload/{hash}/?track_id=edit-...`** (multipart) — ses dosyası (mp3 binary).
   - **`POST /rn/addaudiomp3/form/{upc}`** (multipart) — track kaydı.
   - **`POST /rn/find_track_duplicate.php?upcidd={upc}`** — kopya kontrolü.

6. **`POST /rn/cloud_upload`** — `count=6` (sonlandır).

7. **`POST /rn/addaudiomp3/form/{upc}`** (form) — 6 track adı/dosyası:
   - `tracknio1..6` = track başlıkları, `files[Origin1..6]` = dosya adları
   - Sıra: Original, Slowed, Ultra Slowed, Slowed but Muffled, Sped Up, 8D Audio

8. **`POST /rn/?q=trackmetadata/form/{upc}`** — track-bazlı besteci metadata.

## Açık kalanlar (yapım sırasında netleşecek)
- **Kapak (artwork) upload endpoint'i** — isimden bulunamadı; muhtemelen ayrı bir multipart
  POST (image) ya da editalbum akışında. Capture'da image content-type'lı isteklerden bulunacak.
- **Login POST** — capture zaten giriş yapmış oturumda; ayrı bir login capture gerek (auto-login için).
- Multipart alan adları (cloud_upload chunk yapısı) — dosya upload'ında birebir çıkarılacak.
