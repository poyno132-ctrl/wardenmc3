# WardenMC

- `site/`: web sitesi (index.html, magaza.html, css/, js/)
- `server/`: hesap, mağaza ve PayTR ödeme sunucusu (Node.js 18+)

## Çalıştırma
1. `cd server && npm install`
2. `.env.example` dosyasını `.env` olarak kopyala ve PayTR bilgilerini doldur
3. `npm start`, sonra http://localhost:3000 adresini aç

## Ödeme (PayTR)
- PayTR mağaza panelinde "Bildirim URL" alanına `SITE_URL/api/pay/callback` yaz. Adres herkese açık (https) olmalı.
- Önce `PAYTR_TEST_MODE=1` ile test et, canlıya geçerken `0` yap.
- Coin, sadece PayTR'nin imzalı bildirimi doğrulanınca hesaba eklenir.

## Oyuna teslimat
Satın alınan ürünler `db.json` içinde `deliveries` listesine düşer. Sunucundaki bir eklenti `GET /api/deliveries` adresini
`x-plugin-key: PLUGIN_KEY` başlığıyla yoklayıp bekleyen teslimatları alır (rütbe ver, anahtar ver, set ver).

## Canlıya almadan önce
- `db.json` yerine gerçek bir veritabanı kullan (oturumlar bellekte tutuluyor, sunucu yeniden başlayınca düşer).
- Giriş ve kayıt uçlarına istek sınırı ekle, HTTPS kullan, `NODE_ENV=production` yap.
- Gizlilik, mesafeli satış sözleşmesi ve iade sayfalarını yaz. PayTR ve yasal olarak gerekli.
