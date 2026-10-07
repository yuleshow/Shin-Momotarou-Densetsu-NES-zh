# 世界地名參考圖

[開啟繁體中文 PNG](world-map-zh-Hant.png)

3000 × 2380 像素，共 72 個標籤、71 個不同地名。奈落洞窟在南方及海底兩區重複列示。橙框標示第 53 格存檔檢閱後建議前往的金太郎村與足柄山，不表示玩家目前位置。

## 範圍與限制

這是原創的區域地名與路線關係示意圖，**不是遊戲世界的實際地形圖**。未取得已驗證的全世界底圖，因此沒有繪製海岸線、山脈、道路或推測的座標。卡片的排列是排版位置，不是遊戲座標；應以每個地名下方的文字方位為準。連線只表示部分已知關係，不代表可直接步行的路線。

六組區域也不是世界各大陸的相對位置。海底、地下、月亮與後期區域分組列示；月之祠的不同事件入口不能視為同一座標。怨恨洞窟的來源方位有疑似筆誤，故標示待核；豐饒村僅列區域，不猜測座標。圖中包含後期地名，可能涉及劇透。

繁體中文名稱來自 [v37 完整地名索引](../opening-preview-v37/place-names.md)。主角老家的動態名稱在圖上以預設「桃太郎」表示，不會更動存檔姓名。

下列 16 筆索引未另設標籤：寢太郎之穴、鹿角仙人庵、海之庵、仙人庵、玩家自訂城名、雪原、原野、月亮、臥龍洞窟，以及黑繩、血池、眾合、焦熱、極寒、大焦熱、阿鼻七個地獄區域。部分是區域內部、通用名稱或動態地點；本次沒有足夠定位依據。不是全部 87 筆都已定位。

## 來源

以攻略中的地點、入口及相對方位事實自行整理，未重製攻略圖片或長段落。

- [花木地區](https://onibaka.donburako.com/kouryaku/momo_shin/chart_1.html)
- [冬雪與星辰地區](https://onibaka.donburako.com/kouryaku/momo_shin/chart_2.html)
- [微笑地區](https://onibaka.donburako.com/kouryaku/momo_shin/chart_3.html)
- [希望與南方地區](https://onibaka.donburako.com/kouryaku/momo_shin/chart_4.html)
- [海上與海底](https://onibaka.donburako.com/kouryaku/momo_shin/chart_5.html)
- [勇氣地區與月亮](https://onibaka.donburako.com/kouryaku/momo_shin/chart_6.html)
- [金太郎村至浦島村交叉核對](https://tvgamedb.com/snec/shinmomoden/kouryaku-2/)
- [龍宮城至大江山交叉核對](https://tvgamedb.com/snec/shinmomoden/kouryaku-3/)

## 重建

需要 Node.js、ImageMagick 的 `magick` 及繁體中文字型：

```sh
node tools/render-world-map.mjs /path/to/NotoSansCJKtc-Regular.otf
```

產生器核對索引名稱、文字長度、標籤邊界及標籤不重疊。輸出另經目視檢閱。未驗證實際逐格行走，也未改動 ROM、裝置存檔或截圖。