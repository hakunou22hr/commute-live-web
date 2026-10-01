# commute-live-web（通勤ルートLIVE）

Mac / Xcode / Apple Developer Program / Google Cloud APIキーを使わず、Windowsのブラウザで開発し、iPhoneのSafariからホーム画面に追加して使う無料PWAです。

## 目的

出発前に自宅・勤務地などの位置関係と道路情報を素早く確認し、実際の走行ナビはGoogle Mapsへ引き渡します。

- アプリ内地図: MapLibre GL JS + OpenFreeMap
- 交通状況を考慮した走行ナビ: Google Maps URL
- 渋滞・事故・通行止め・車線規制等: JARTIC公式ページ
- 雪・冬期道路情報: 青森みち情報
- 保存地点: ブラウザの localStorage のみ
- APIキー・秘密情報: 不要

## 重要な制限

このPWA自身は、Google Mapsのようなバックグラウンド常時ナビ・自動再ルート監視を行いません。

アプリ内地図に表示される青い点線は、選択した2地点の「位置関係」であり、道路上の走行ルートではありません。実際の渋滞・交通状況を考慮した経路は「Google Mapsで最適ルート」から確認してください。

雪・凍結・除雪状況など、公式情報として取得していない内容は推測表示しません。

## iPhoneで使う

GitHub Pages公開後、iPhoneのSafariで次を開きます。

https://hakunou22hr.github.io/commute-live-web/

1. Safari下部の共有ボタンをタップ
2. 「ホーム画面に追加」
3. 「追加」
4. ホーム画面の「通勤LIVE」から起動
5. 初回のみ位置情報利用を必要に応じて許可

保存した自宅・勤務地は、そのiPhoneのブラウザ内だけに保存されます。

## GitHub Pages

このリポジトリには `.github/workflows/pages.yml` を含めています。

GitHub Freeで無料公開する場合は、リポジトリを **Public** にしたうえで:

1. Repository > Settings > Pages
2. Build and deployment
3. Source を **GitHub Actions** に設定
4. mainへのpush後、Actionsの `Deploy GitHub Pages` が成功することを確認

## 主な機能

- iPhone優先レスポンシブUI
- ダーク / ライトモード
- PWA manifest / Service Worker
- 自宅・勤務地など複数地点の保存
- 現在位置取得
- 出発地・到着地の入れ替え
- MapLibre地図のパン / ズーム / 現在地
- Google Maps URLによる経路・走行ナビへの引き渡し
- JARTIC青森エリアへの直接リンク
- 青森みち情報への直接リンク
- Web Speech APIが使える場合の短い日本語読み上げ
- オフライン表示
- App shellのオフラインキャッシュ

## データとプライバシー

地点名・住所・緯度経度は `localStorage` に保存され、GitHubや独自サーバーには送信しません。

Google Mapsボタンを押したときだけ、選択した出発地・到着地をGoogle Maps URLのパラメータとしてGoogle Mapsへ渡します。

JARTIC・青森みち情報は各公式サイトを別タブで開きます。スクレイピングは行いません。

## 情報源

- JARTIC: https://www.jartic.or.jp/map/?p=R02
- 青森みち情報: https://aomori.cc/road/sp/
- OpenFreeMap: https://openfreemap.org/
- MapLibre GL JS: https://maplibre.org/maplibre-gl-js/docs/
- Google Maps URLs: https://developers.google.com/maps/documentation/urls/get-started

## 開発

ビルド工程はありません。静的ファイルだけで動きます。

ローカル確認例:

```bash
python -m http.server 4173
```

ブラウザで `http://localhost:4173/` を開きます。

## 安全

運転中は端末を操作しないでください。出発前に設定し、道路標識・警察・道路管理者の指示を優先してください。
