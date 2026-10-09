import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const font = process.argv[2];
assert.ok(font && fs.existsSync(font), 'Supply a Traditional Chinese font file');
const diagrams = [
  {
    file: 'journey.png', title: '從啟程到真正結局', subtitle: '主線總覽 / 數字是流程順序，不是地圖座標',
    rows: [
      ['01', '老家、飯糰村、松葉山', '領新月水晶；救出雉、犬、猴。'],
      ['02', '金太郎村、浦島村、月亮', '救兩位同伴；寧靜村試練取得月之鏡。'],
      ['03', '大江山、冰之塔', '三日月水晶；鉤繩、冰室袋；夜叉姬加入。'],
      ['04', '微笑村、希望之都', '先救微笑村，再建城；送糖取上弦水晶。'],
      ['05', '風神谷、牢獄、猴蟹村', '尋回失散者；露肚怪取下弦水晶；取得船。'],
      ['06', '海上、海底、奈落', '三片水晶；兩階段潛水改造；救閻魔。'],
      ['07', '竹取村、月宮、三途川', '勇氣之劍；滿月水晶；八片復活鳳凰。'],
      ['08', '豐饒村、地獄、北方天空', '重鑄劍；王之間連戰後，仍有最終迦樓羅。'],
    ],
  },
  {
    file: 'ooeyama.png', title: '大江山：上山七道關卡', subtitle: '先備撤退物品 / 山頂三號店休息後才下山',
    rows: [
      ['2F', '石板配對', '八塊石板、四組相同文字；記住翻開的位置。'],
      ['3F', '龍、虎、龜推疊', '龍壓虎 / 虎壓龜 / 龜壓龍。'],
      ['4F', '推石開路', '從左側繞，保留右側出口的通路。'],
      ['5F', '方向順序', '右、左、左、上、右、下、右。'],
      ['6F', '紅格與夾牆', '避開紅色地板；牆逼近後，通道也會縮小。'],
      ['7F', '綠石戰', '打倒全部 20 顆綠石；分配技與補給。'],
      ['8F', '彩虹排序', '中間五色由左至右如下，不要推死在邊角。'],
    ],
    swatches: [['橙', '#e89237'], ['黃', '#ecd149'], ['黃綠', '#a5cc50'], ['水藍', '#76d1df'], ['藍', '#397cbd']],
  },
  {
    file: 'rescue.png', title: '風神谷之後：先恢復戰力', subtitle: '開門範例 / 桃太郎、金太郎、浦島、夜叉姬：平均 48 公斤',
    rows: [
      ['01', '谷內失散，回城補人', '北方並排地藏會提供失散同伴的去向。'],
      ['02', '先找金太郎：寢太郎村', '稍後救浦島、阿修羅，都需要金太郎同行。'],
      ['03', '夜叉姬：四號店附近雪原', '伏龍洞窟取龍鱗，交四號店醫生治病。'],
      ['04', '伏龍戰的期限', '第六回合會送出洞窟，必須提前取勝。'],
      ['05', '犬、猴、雉：雷神洞窟', '途中尋回；雷神戰留資源應付風神增援。'],
      ['06', '阿修羅：鬼族牢獄', '到達牢獄後，帶金太郎救出。'],
      ['07', '浦島：山姥洞窟祭壇', '帶金太郎搬開木材；這是較後段的救援。'],
    ],
  },
  {
    file: 'deep-sea.png', title: '船、潛水與深海的先後順序', subtitle: '普通潛水與深海改造不同 / 只做第一項不能進奈落',
    rows: [
      ['01', '山姥事件後，回猴蟹村取船', '站在原本風神、雷神的位置等船匠交船。'],
      ['02', '船進鬼之爪痕地下水路', '找到機關村，請孫市改造城堡飛行與潛水。'],
      ['03', '普通海底探索', '取十六夜水晶；龍宮城收浦島裝備。'],
      ['04', '左源內庵、人魚村', '先問改造；救治人魚，取得人魚之淚。'],
      ['05', '回左源內做深海改造', '帶人魚之淚，而且風神、雷神都要同行。'],
      ['06', '鬼島東北海底裂縫進奈落', '下潛到底層；破牢前目前總血至少 500。'],
      ['07', '救閻魔後走南出口', '南方通竹取村地區；北方返回冬雪地區。'],
    ],
  },
  {
    file: 'crystals.png', title: '月之水晶：八片收集核對', subtitle: '依取得方式分列 / 水晶需確實領取，不能只到訪地點',
    rows: [
      ['01', '新月水晶', '飯糰村建成後，回去向甚八領取。'],
      ['02', '三日月水晶', '大江山，戰勝酒吞童子。'],
      ['03', '上弦水晶', '解放希望之都，送麥芽糖給證城寺和尚。'],
      ['04', '下弦水晶', '帶露肚怪回伸長怪森林，與長老交談。'],
      ['05', '臥待水晶 / 十九夜月相', '浦島持釣竿，在寢太郎村西方小島旁釣魚。'],
      ['06', '居待水晶 / 十八夜月相', '彩虹洞窟深處，打開寶箱。'],
      ['07', '十六夜水晶', '避魔仙人庵東南海底，調查月之鏡光點。'],
      ['08', '滿月水晶', '三途川小屋，戰勝懸衣翁、奪衣婆。'],
    ],
  },
  {
    file: 'finale.png', title: '終盤：伐折羅王之後還有一戰', subtitle: '重大事件前保留獨立普通存檔 / 不要只留戰鬥即時存檔',
    rows: [
      ['01', '八片水晶帶回月之宮殿', '地下女性的事件使鳳凰復活，取得鳳凰笛。'],
      ['02', '月上飛往豐饒村', '先完成支線與補給，另留未覆蓋的存檔。'],
      ['03', '星夜與白砂泉', '依指示重鑄勇氣之劍，再整理終盤裝備。'],
      ['04', '鳳凰跨三途川，深入地獄', '焦熱洞口傷害不能靠浮游防止。'],
      ['05', '三千世界、迦樓羅、伐折羅王', '連戰留補給；迦樓羅回聲反傷要注意。'],
      ['06', '鳳凰離開鬼島', '疲乏時先回竹取村區域整備，再向北飛。'],
      ['07', '北方天空：最終迦樓羅', '持續攻防，直到全身石化並進入結局。'],
      ['08', '戰後月之鈴', '依輝夜姬指示，回開海的勇氣岬使用。'],
    ],
  },
];

const colors = ['#27705b', '#286b8b', '#99465c', '#82701e'];
const outputDirectory = path.join(directory, 'images');
fs.mkdirSync(outputDirectory, { recursive: true });
const measurements = new Map();
const magick = args => {
  const result = spawnSync('magick', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
};

for (const diagram of diagrams) {
  const width = 1200;
  const height = 225 + diagram.rows.length * 116 + (diagram.swatches ? 105 : 0);
  const args = ['-size', `${width}x${height}`, 'xc:#f7f9f8', '-font', font, '-encoding', 'UTF-8'];
  const draw = (fill, stroke, shape) => args.push('-fill', fill, '-stroke', stroke, '-strokewidth', '2', '-draw', shape);
  const text = (value, left, top, size, color = '#243b38', maxWidth = width - left - 45) => {
    const key = `${size}:${value}`;
    if (!measurements.has(key)) {
      measurements.set(key, magick(['-font', font, '-pointsize', String(size), `label:${value}`, '-format', '%w %h', 'info:']).split(' ').map(Number));
    }
    const [textWidth, textHeight] = measurements.get(key);
    assert.ok(textWidth <= maxWidth, `Text too wide: ${value} (${textWidth} > ${maxWidth})`);
    assert.ok(top + textHeight < height, `Text too low: ${value}`);
    args.push('-fill', color, '-stroke', 'none', '-pointsize', String(size), '-gravity', 'NorthWest', '-annotate', `+${left}+${top}`, value);
  };
  draw('#27705b', 'none', `rectangle 0,0 ${width},12`);
  text(diagram.title, 48, 35, 44);
  text(diagram.subtitle, 50, 105, 25, '#556866');
  for (const [index, row] of diagram.rows.entries()) {
    const top = 172 + index * 116;
    const color = colors[index % colors.length];
    draw(index % 2 ? '#edf2f1' : '#ffffff', 'none', `rectangle 35,${top} 1165,${top + 104}`);
    draw(color, 'none', `rectangle 35,${top} 41,${top + 104}`);
    text(row[0], 57, top + 22, 33, color, 82);
    text(row[1], 155, top + 7, 33);
    text(row[2], 155, top + 58, 26, '#52615f');
  }
  if (diagram.swatches) {
    const top = 185 + diagram.rows.length * 116;
    for (const [index, [name, color]] of diagram.swatches.entries()) {
      const left = 155 + index * 185;
      draw(color, '#67736f', `rectangle ${left},${top} ${left + 160},${top + 35}`);
      text(name, left + 28, top + 43, 25);
    }
  }
  text('原創流程示意 / 不是遊戲截圖、地形圖或逐格路線', 50, height - 41, 20, '#556866');
  const output = path.join(outputDirectory, diagram.file);
  args.push(output);
  magick(args);
  const [actualWidth, actualHeight, deviation] = magick([output, '-format', '%w %h %[standard-deviation]', 'info:']).split(' ').map(Number);
  assert.equal(actualWidth, width);
  assert.equal(actualHeight, height);
  assert.ok(deviation > 100, `Blank image: ${diagram.file}`);
  console.log(`PASS ${diagram.file}: ${width}x${height}, text bounds and nonblank pixels`);
}