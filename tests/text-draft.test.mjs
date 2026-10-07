import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { catalog, compileTextDraft } from '../tools/text-catalog.mjs';

const read = name => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url)));
const rom = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));

for (const name of ['screenshot-battle-status-escape', 'screenshot-yashahime-battle']) {
  test(`raw draft ${name} retains exact source offsets and record bytes`, () => {
    const draft = read(`translations/${name}.draft.zh-Hant.json`);
    const compiled = compileTextDraft(rom, draft);
    assert.equal(compiled.entries.length, Object.keys(draft.records).length);
    assert.equal(compiled.complete, false);
    for (const [index, source] of Object.entries(draft.sourceRecords)) {
      const entry = compiled.entries.find(item => item.offset === source.offset);
      assert.ok(entry, `Missing record ${index}`);
      assert.equal(entry.originalHex, source.originalHex);
      assert.equal(rom.subarray(Number(entry.offset), Number(entry.offset) + entry.originalHex.length / 2).toString('hex'), entry.originalHex);
    }
  });
}

test('raw draft rejects changed dynamic controls, false completeness and absent records', () => {
  const draft = read('translations/screenshot-battle-status-escape.draft.zh-Hant.json');
  const changed = structuredClone(draft);
  changed.records[17] = changed.records[17].replace('[09]', '');
  assert.throws(() => compileTextDraft(rom, changed), /Draft controls differ/);
  assert.throws(() => compileTextDraft(rom, { ...draft, complete: true }), /every selected indexed record/);
  assert.throws(() => compileTextDraft(rom, { ...draft, records: { 999: '不存在' } }), /every selected indexed record/);
  assert.throws(() => compileTextDraft(rom, { ...draft, sourceSha256: '0'.repeat(64) }));
  assert.throws(() => compileTextDraft(rom, { ...draft, pointerOffset: '0x70049' }));
});

test('raw draft retains kana mode changes and removes only fixed dictionary references', () => {
  const draft = read('translations/screenshot-yashahime-battle.draft.zh-Hant.json');
  const compiled = compileTextDraft(rom, draft);
  const retainedModes = entry => entry.segments.filter(segment => ['03', '04'].includes(segment.hex)).map(segment => segment.hex);
  const withModes = compiled.entries.find(entry => entry.offset === draft.sourceRecords[2].offset);
  assert.deepEqual(retainedModes(withModes), ['04', '03']);
  const staticPronoun = compiled.entries.find(entry => entry.offset === draft.sourceRecords[3].offset);
  assert.ok(!staticPronoun.segments.some(segment => segment.hex === '02c9'));
  const postbattle = compiled.entries.find(entry => entry.offset === draft.sourceRecords[17].offset);
  assert.equal(postbattle.segments.filter(segment => segment.hex === '11').length, 3);
});

test('full-width draft spaces become two native half-width spaces', () => {
  const draft = read('translations/mashira-pun-contest.draft.zh-Hant.json');
  const entry = compileTextDraft(rom, { ...draft, complete: false, records: { 0: draft.records[0] } }).entries[0];
  assert.ok(entry.segments.some(segment => segment.hex === '5050'));
  assert.ok(entry.segments.every(segment => !segment.text?.includes('\u3000')));
});

test('existing compressed source compiles identically to the frozen release', () => {
  const frozen = read('opening-preview-v42-sumo-fix/resolved-translation-manifest.json');
  for (const name of ['dragon-palace-entry', 'dragon-palace-rescue-complete', 'dragon-palace-moon-complete', 'ooeyama-rock-puzzle']) {
    const draft = read(`translations/${name}.draft.zh-Hant.json`);
    const compiled = compileTextDraft(rom, draft);
    const previous = frozen.textBlocks.find(block => block.pointerOffset === draft.pointerOffset);
    assert.deepEqual(compiled.entries, previous.entries);
    assert.equal(compiled.decodedBytes, previous.decodedBytes);
  }
});

for (const [name, minimum] of [['quiz-history-early-adventure', 30], ['quiz-history-middle-adventure', 14]]) {
test(`${name} answer names match the released glossary`, () => {
  const draft = read(`translations/${name}.draft.zh-Hant.json`);
  const manifest = read('opening-preview-v46/resolved-translation-manifest.json');
  const source = catalog(rom, manifest, read('translations/opening.zh-Hant.json'));
  const block = source.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  let checked = 0;
  for (const record of block.records) {
    const names = manifest.nameBlocks.flatMap(block => block.entries
      .filter(entry => entry.originalHex === record.originalHex).map(entry => entry.translation));
    if (!names.length) continue;
    assert.ok(names.includes(draft.records[record.index]), `Quiz glossary mismatch: ${record.index}`);
    checked++;
  }
  assert.ok(checked >= minimum);
});
}

test('quiz-history drafts retain ordered numeric alternatives', () => {
  const first = read('translations/quiz-history-early-adventure.draft.zh-Hant.json').records;
  const second = read('translations/quiz-history-middle-adventure.draft.zh-Hant.json').records;
  assert.deepEqual([57, 58, 59].map(index => first[index]), ['１００次', '１０８次', '１２０次']);
  assert.deepEqual([81, 82, 83].map(index => first[index]), ['１９８５年', '１９８６年', '１９８７年']);
  assert.deepEqual([13, 14, 15].map(index => second[index]), ['１００兩', '５００兩', '１０００兩']);
  assert.deepEqual([33, 34, 35].map(index => second[index]), ['１００兩', '５００兩', '１０００兩']);
  assert.deepEqual([73, 74, 75].map(index => second[index]), ['３０段', '４５段', '９９段']);
  assert.deepEqual([77, 78, 79].map(index => second[index]), ['６００００兩', '６５５３５兩', '９９９９９兩']);
});

test('credits-role-labels preserves names, copyright notices and spacing', () => {
  const draft = read('translations/credits-role-labels.draft.zh-Hant.json');
  assert.deepEqual(Object.keys(draft.records).map(Number), [3, 4, 15, 17, 25, 35, 37, 56, 59, 82, 83, 91, 92, 93]);
  const manifest = read('opening-preview-v46/resolved-translation-manifest.json');
  const source = catalog(rom, manifest, read('translations/opening.zh-Hant.json'));
  const block = source.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  assert.equal(block.records.filter(record => record.originalHex && !Object.hasOwn(draft.records, record.index)).length, 79);
  assert.equal(block.records[8].originalHex, '82525a5a5450687564736f6e50736f6674');
  assert.equal(block.records[9].originalHex, '82525a5a545073756d6d65725070726f6a656374');
  assert.equal(block.records[10].originalHex, '505050505050505050505050');
});

test('castle-water-and-name-labels excludes keyboard and suggested-name records', () => {
  const draft = read('translations/castle-water-and-name-labels.draft.zh-Hant.json');
  const expected = [...Array.from({ length: 24 }, (_, index) => index), 188,
    ...Array.from({ length: 9 }, (_, index) => 190 + index), 228, 229, 230];
  assert.deepEqual(Object.keys(draft.records).map(Number), expected);
  const manifest = read('opening-preview-v46/resolved-translation-manifest.json');
  const source = catalog(rom, manifest, read('translations/opening.zh-Hant.json'));
  const block = source.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  assert.equal(block.records.filter(record => !Object.hasOwn(draft.records, record.index)).length, 194);
  assert.equal(draft.records[188], '完成');
  assert.equal(draft.records[22], '[02a0]歷史室');
});

for (const [name, count, complete = true] of [
  ['quiz-history-early-adventure', 176],
  ['quiz-history-middle-adventure', 176],
  ['castle-water-and-name-labels', 37, false],
  ['credits-role-labels', 14, false],
  ['senzu-bean-stall', 3],
  ['windchime-stall', 4],
  ['ashura-riddle-hints', 49],
  ['toranobu-wagashi-shop', 14],
  ['literacy-arithmetic-school', 39],
  ['kimono-dye-shop', 7],
  ['junan-pickle-exchange', 19],
  ['ishii-restaurant', 46],
  ['mizuame-stall', 5],
  ['hope-capital-lottery', 19],
  ['castle-carpenter-services', 20],
  ['dog-show-contest', 20],
  ['bathhouse-services', 12],
  ['rice-ball-offering', 74],
  ['new-village-teahouse', 8],
  ['sea-route-teahouse', 8],
  ['taketori-island-refuge', 25],
  ['village-cough-remedy', 17],
  ['mashira-pun-contest', 24],
  ['mashira-stage-tournament', 49],
  ['fukuryuu-cave-inn', 10],
  ['new-village-crisis', 73],
  ['shipbuilding-village-storm', 53],
  ['taketori-village-refugees', 27],
  ['kaguya-family-sword-clue', 9],
  ['kaguya-bamboo-sword-search', 13],
  ['karura-weight-gate', 6],
  ['gods-village-gate', 7],
  ['gods-village-companions', 21],
  ['gods-village-hints', 5],
  ['biron-forest-crystal', 15, false],
  ['haradashi-village-satokichi', 19],
  ['haradashi-biron-dialogue', 22, false],
  ['immortal-retreat-guidance', 14],
  ['tanabata-star-well', 23],
  ['heaven-tree-growth', 1],
  ['hanasaka-visitors', 42],
  ['oni-curses-and-breath', 30],
  ['spell-chants-remaining', 27, false],
  ['battle-events-remaining', 148, false],
  ['battle-messages-remaining', 150, false],
  ['battle-effects-remaining', 141, false],
  ['shared-dictionary-remaining', 35, false],
  ['boss-battle-final-message', 2, false],
  ['battle-command-labels-remaining', 62, false],
  ['character-labels-remaining', 45, false],
  ['common-status-labels-remaining', 69, false],
  ['item-readings-remaining', 142, false],
  ['equipment-readings-remaining', 166, false],
  ['technique-readings-remaining', 93, false],
  ['hope-capital-siege', 19],
  ['hope-capital-residents', 39],
  ['hope-capital-temple', 6],
  ['hope-capital-city-life', 12],
  ['hope-capital-newspaper-windchime', 14],
  ['hope-capital-ashura-negotiation', 8],
  ['hope-capital-castle-construction', 14],
]) {
  test(`${name} preserves ${complete ? 'complete' : 'selected'} source controls and 14-cell lines`, () => {
    const draft = read(`translations/${name}.draft.zh-Hant.json`);
    const compiled = compileTextDraft(rom, draft);
    assert.equal(draft.complete, complete);
    assert.equal(compiled.entries.length, count);
    for (const [index, text] of Object.entries(draft.records)) {
      let field = 0;
      const rendered = text.replaceAll('[02a0]', '桃太郎')
        .replaceAll('[02b9]', ['quiz-history-early-adventure', 'item-readings-remaining', 'equipment-readings-remaining'].includes(name) ? '勇氣' : '[02b9]')
        .replaceAll('[02b8]', name === 'equipment-readings-remaining' ? '正義' : '[02b8]')
        .replaceAll('[02b2]', name === 'item-readings-remaining' ? '道具' : '[02b2]')
        .replaceAll('[02ae]', 'のじゅつ')
        .replace(/\[0[67]\]/g, control => name === 'common-status-labels-remaining'
          || (name === 'battle-messages-remaining' && ['12', '13', '16', '19', '47', '49', '52', '86', '92', '175'].includes(index) && control === '[06]') ? '' : control)
        .replaceAll('[11]', '甲乙丙丁戊')
        .replaceAll('[0a]', '99999')
        .replaceAll('[0b]', '')
        .replace(/\[(?:05|08|0f)\]/g, '')
        .replace(/\[09\]/g, () => {
          field++;
          if (name === 'common-status-labels-remaining' && index === '115' && field <= 2) return '甲乙丙丁戊';
          if (name === 'boss-battle-final-message') return field === 1 ? '甲乙丙丁戊己庚辛' : '等人';
          if (name === 'battle-effects-remaining') {
            if (['4', '25', '31', '33', '34', '124', '133'].includes(index) || (index === '67' && field === 5)) return '甲乙丙丁戊己庚辛';
            if (index === '143' && field >= 5) return field === 7 ? '等人' : '甲乙丙丁戊己庚辛';
            if (['15', '67', '70', '81', '82', '100', '143', '146'].includes(index)) return field % 2 === 1 ? '甲乙丙丁戊' : '君';
            return field % 2 === 1 ? '甲乙丙丁戊己庚辛' : '等人';
          }
          if (name === 'battle-messages-remaining') {
            if (index === '25') return '甲乙丙丁戊己';
            if (index === '169') return [2, 5].includes(field) ? '等人' : '甲乙丙丁戊己庚辛';
            if (index === '180') return field === 3 ? '等人' : '甲乙丙丁戊己庚辛';
            if (index === '135' && field >= 3) return field % 2 === 1 ? '甲乙丙丁戊' : '君';
            if (['14', '15', '18'].includes(index) && field === 3) return '攻擊力';
            return field % 2 === 1 ? '甲乙丙丁戊己庚辛' : '等人';
          }
          if (name === 'battle-events-remaining' && index === '59') {
            if (field === 2) return '甲乙丙丁戊己';
            return field === 3 ? '等人' : '雞肉芥末';
          }
          if (name === 'battle-events-remaining' && ['68', '102', '103', '104', '185'].includes(index)) {
            return field % 2 === 1 ? '甲乙丙丁戊己庚辛' : '等人';
          }
          if (name === 'battle-events-remaining' && index === '105') {
            if (field === 1) return '雪人';
            return field === 2 ? '等人' : '甲乙丙丁戊己庚辛';
          }
          if (name === 'oni-curses-and-breath') {
            if (index === '13') return '甲乙丙丁戊己';
            return field === 1 ? '甲乙丙丁戊己庚辛' : '等人';
          }
          const recipient = name === 'toranobu-wagashi-shop' && (index === '9' || (index === '10' && field === 1));
          const castleName = name === 'hope-capital-castle-construction';
          const crisisCompanion = name === 'new-village-crisis' && [7, 8, 37, 60, 65, 70, 71].includes(Number(index));
          const starWellNameOrStat = name === 'tanabata-star-well' && (index === '22' || (index === '11' && field === 1));
          return recipient || castleName || crisisCompanion || starWellNameOrStat ? '甲乙丙丁戊' : '甲乙丙丁戊己庚辛';
        });
      assert.ok(!/\[[0-9a-f]+\]/i.test(rendered), `${name}:${index} has an unchecked dynamic field`);
      for (const line of rendered.split('\n')) {
        assert.ok([...line].length <= 14, `${name}:${index} exceeds 14 cells: ${line}`);
      }
    }
  });
}

test('battle diagnostic translations retain exact source bytes and nonprinting controls', () => {
  const draft = read('translations/battle-messages-remaining.draft.zh-Hant.json');
  const sources = {
    12: '0668616c665064616d6167650f',
    86: '06726576697665506e657874507475726e',
    92: '06726576697665506e657874507475726e',
    175: '0674617267657450697350646561645c0f',
  };
  for (const [index, originalHex] of Object.entries(sources)) {
    const text = draft.records[index];
    const entry = compileTextDraft(rom, { ...draft, records: { [index]: text } }).entries[0];
    assert.equal(entry.originalHex, originalHex);
    assert.deepEqual(entry.segments.filter(segment => segment.hex).map(segment => segment.hex),
      ['12', '175'].includes(index) ? ['06', '0f'] : ['06']);
    assert.throws(() => compileTextDraft(rom, { ...draft, records: { [index]: text.replace('[06]', '') } }), /Draft controls differ/);
  }
});

test('boss developer placeholder retains its source newline and battle terminator', () => {
  const draft = read('translations/boss-battle-final-message.draft.zh-Hant.json');
  const entry = compileTextDraft(rom, { ...draft, records: { 1: draft.records[1] } }).entries[0];
  assert.equal(entry.originalHex, 'b3b6b99fa396a801a3979bf79bf8b7a4dd0f');
  assert.deepEqual(entry.segments.filter(segment => segment.hex).map(segment => segment.hex), ['01', '0f']);
  assert.throws(() => compileTextDraft(rom, { ...draft, records: { 1: draft.records[1].replace('\n', '') } }), /Draft controls differ/);
});

test('stall price, riddle branches and school formatting retain source details', () => {
  const dyeShop = read('translations/kimono-dye-shop.draft.zh-Hant.json');
  assert.ok(dyeShop.records[0].includes('３００兩'));
  const stall = read('translations/windchime-stall.draft.zh-Hant.json');
  assert.ok(stall.records[0].includes('３０兩'));
  const hints = read('translations/ashura-riddle-hints.draft.zh-Hant.json');
  assert.equal(hints.records[29], hints.records[32]);
  const school = read('translations/literacy-arithmetic-school.draft.zh-Hant.json');
  assert.equal(school.records[37], '  第[0a]題');
  assert.equal(school.records[17], school.records[38]);
  assert.ok(school.records[20].includes('１３＋２＝５８２'));
  assert.ok(school.records[28].includes('１０兩'));
});

test('pickle exchange retains ratios, capacity and duplicate responses', () => {
  const draft = read('translations/junan-pickle-exchange.draft.zh-Hant.json');
  for (const value of ['８根', '１６根', '６４根']) assert.ok(draft.records[7].includes(value));
  assert.ok(draft.records[4].includes('６４根'));
  assert.equal(draft.records[9], draft.records[14]);
  assert.equal(draft.records[13], draft.records[18]);
});

test('restaurant preserves repeated fish-sale branches and meal pause', () => {
  const draft = read('translations/ishii-restaurant.draft.zh-Hant.json');
  for (const index of [26, 27, 28, 29, 30]) assert.equal(draft.records[index], '[09][0a]條\n\n');
  assert.equal(draft.records[25], draft.records[32]);
  assert.ok(draft.records[20].endsWith('[0b]'));
  assert.ok(draft.records[41].includes('卡在喉嚨'));
});

test('mizuame and lottery retain prices, prizes and the historical promotion code', () => {
  const stall = read('translations/mizuame-stall.draft.zh-Hant.json');
  assert.ok(stall.records[0].includes('３０兩'));
  assert.equal(stall.records[1], stall.records[4]);
  const lottery = read('translations/hope-capital-lottery.draft.zh-Hant.json');
  assert.ok(lottery.records[0].includes('１００兩'));
  for (const [index, prize] of [[4, '１００００兩'], [5, '３０００兩'], [6, '１０００兩']]) {
    assert.equal(lottery.records[index].split(prize).length, 3);
  }
  assert.ok(lottery.records[15].includes('１９９４年４月３０日'));
  assert.equal(lottery.records[18], ' \nねでいなえしおはにちだもと\n ');
});

test('castle services retain one-time relocation and prohibited terrain', () => {
  const draft = read('translations/castle-carpenter-services.draft.zh-Hant.json');
  assert.ok(draft.records[7].includes('只有一次'));
  assert.ok(draft.records[18].includes('僅限一次'));
  assert.ok(draft.records[8].includes('樹木或河川'));
  assert.ok(draft.records[5].includes('圈地絲還沒用掉'));
});

test('dog show retains timing, judging experience, feeding boast and prizes', () => {
  const draft = read('translations/dog-show-contest.draft.zh-Hant.json');
  assert.ok(draft.records[1].includes('四十年'));
  assert.ok(draft.records[4].includes('十公斤鯖魚壽司'));
  assert.ok(draft.records[7].includes('三分鐘'));
  for (const index of [14, 15]) assert.ok(draft.records[index].includes('１００００兩'));
  assert.ok(draft.records[16].includes('１０００兩'));
});

test('bathhouse retains its per-person fee, recovery notice and exit button', () => {
  const draft = read('translations/bathhouse-services.draft.zh-Hant.json');
  assert.ok(draft.records[8].includes('每人１０兩'));
  assert.ok(draft.records[1].includes('體力與技力'));
  assert.ok(draft.records[6].includes('Ａ鈕'));
  assert.equal(draft.records[11].match(/\[0a\]/g).length, 2);
});

test('expanded rice-ball block preserves the six released records and target', () => {
  const draft = read('translations/rice-ball-offering.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const previous = frozen.textBlocks.find(block => block.pointerOffset === draft.pointerOffset);
  const compiled = compileTextDraft(rom, draft);
  assert.equal(previous.entries.length, 6);
  assert.deepEqual(compiled.entries.slice(0, 6), previous.entries);
  assert.equal(compiled.target, previous.target);
});

test('expanded Hanasaka visitors preserve released entries, target and route clues', () => {
  const draft = read('translations/hanasaka-visitors.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const previous = frozen.textBlocks.find(block => block.pointerOffset === draft.pointerOffset);
  const compiled = compileTextDraft(rom, draft);
  assert.equal(previous.entries.length, 4);
  assert.deepEqual(compiled.entries.slice(11, 15), previous.entries);
  assert.equal(compiled.target, previous.target);
  assert.ok(draft.records[17].includes('足柄山'));
  assert.ok(draft.records[17].includes('挖金礦'));
  assert.ok(draft.records[30].includes('假裝聽不見'));
  assert.ok(draft.records[39].includes('啟程村西側'));
});

test('Jizo hints and castle branches retain directions, duplicates and dynamic catches', () => {
  const draft = read('translations/rice-ball-offering.draft.zh-Hant.json');
  for (const [index, direction] of [[27, '西邊'], [31, '南邊'], [34, '東邊'], [49, '東南方']]) {
    assert.ok(draft.records[index].includes(direction));
  }
  assert.equal(draft.records[35], draft.records[38]);
  assert.equal(draft.records[59], draft.records[63]);
  assert.ok(draft.records[68].includes('耐久度是０'));
  assert.equal(draft.records[72].match(/\[09\]/g).length, 3);
});

test('teahouse and refugee hints preserve access conditions and meteorite location', () => {
  const route = read('translations/sea-route-teahouse.draft.zh-Hant.json');
  assert.ok(route.records[4].includes('船也無法抵達'));
  assert.ok(route.records[5].includes('種下種子'));
  const refuge = read('translations/taketori-island-refuge.draft.zh-Hant.json');
  assert.equal(refuge.records[0], refuge.records[1]);
  assert.ok(refuge.records[15].includes('竹取村西邊'));
  assert.ok(refuge.records[16].includes('月上的豐饒村'));
  assert.ok(refuge.records[16].includes('隕石'));
});

test('completed cough block preserves its two released records and target', () => {
  const draft = read('translations/village-cough-remedy.draft.zh-Hant.json');
  const previous = read('opening-preview-v45/resolved-translation-manifest.json').textBlocks.find(block => block.pointerOffset === draft.pointerOffset);
  const compiled = compileTextDraft(rom, draft);
  const offsets = new Set(previous.entries.map(entry => entry.offset));
  assert.equal(offsets.size, 2);
  assert.deepEqual(compiled.entries.filter(entry => offsets.has(entry.offset)), previous.entries);
  assert.equal(compiled.target, previous.target);
});

test('Mashira tournament preserves parody dates, rules and repeated prompts', () => {
  const draft = read('translations/mashira-stage-tournament.draft.zh-Hant.json');
  for (const year of ['１９４０', '１９６２', '１９６４', '１９６５']) assert.ok(draft.records[17].includes(year));
  assert.ok(draft.records[21].includes('５０兩'));
  assert.ok(draft.records[25].includes('１００點'));
  assert.ok(draft.records[25].includes('八人'));
  for (const index of [13, 14, 15]) assert.equal(draft.records[index], draft.records[12]);
  assert.equal(draft.records[23], draft.records[39]);
});

test('new village crisis preserves lunar destination, evacuation route and repeated states', () => {
  const draft = read('translations/new-village-crisis.draft.zh-Hant.json');
  assert.ok(draft.records[15].includes('不是寧靜村'));
  assert.ok(draft.records[15].includes('而是夢之村'));
  assert.ok(draft.records[61].includes('猴蟹村'));
  assert.ok(draft.records[61].includes('鬼族牢房的地下'));
  assert.ok(draft.records[61].includes('足以載下所有人的大船'));
  for (const [left, right] of [[1, 2], [68, 69], [70, 71]]) assert.equal(draft.records[left], draft.records[right]);
});

test('storm dialogue preserves routes, sea monopoly and spell-sealing distinction', () => {
  const draft = read('translations/shipbuilding-village-storm.draft.zh-Hant.json');
  assert.ok(draft.records[7].includes('西邊的山'));
  assert.ok(draft.records[8].includes('搭船往東北方'));
  assert.ok(draft.records[18].includes('鬼道攻擊無法阻止'));
  assert.ok(draft.records[18].includes('法術能用封印術封住'));
  assert.ok(draft.records[23].includes('連大海都想獨占'));
  assert.equal(draft.records[23], draft.records[24]);
});

test('refugees and sword search preserve access conditions, mirror and directional steps', () => {
  const refugees = read('translations/taketori-village-refugees.draft.zh-Hant.json');
  assert.ok(refugees.records[4].includes('北邊的海角'));
  assert.ok(refugees.records[6].includes('東邊湖底'));
  assert.equal(refugees.records[5], refugees.records[7]);
  const family = read('translations/kaguya-family-sword-clue.draft.zh-Hant.json');
  assert.ok(family.records[4].includes('勇氣之鏡'));
  const search = read('translations/kaguya-bamboo-sword-search.draft.zh-Hant.json');
  assert.ok(search.records[1].includes('１２０年'));
  for (const [index, direction] of [[9, '西'], [10, '東'], [11, '北'], [12, '南']]) {
    assert.equal(search.records[index], `向${direction}[0a]步！${index >= 11 ? '\n' : ''}`);
  }
});

test('weight gate retains average rather than total and gods gate retains the soup requirement', () => {
  const weight = read('translations/karura-weight-gate.draft.zh-Hant.json');
  assert.ok(weight.records[2].includes('四個人也會開'));
  assert.ok(weight.records[3].includes('平均體重是[0a]公斤'));
  assert.ok(weight.records[3].includes('平均４８公斤'));
  assert.ok(weight.records[4].includes('確實是４８公斤'));
  const gate = read('translations/gods-village-gate.draft.zh-Hant.json');
  assert.ok(gate.records[0].includes('還沒蓋城堡'));
  assert.ok(gate.records[1].includes('神之味噌湯'));
});

test('Amanojaku preserves deliberate falsehoods and the changing recruitment items', () => {
  const companions = read('translations/gods-village-companions.draft.zh-Hant.json');
  assert.ok(companions.records[5].includes('露肚怪村的人'));
  assert.ok(companions.records[6].includes('露肚怪就在'));
  assert.ok(companions.records[6].includes('一直往南'));
  assert.ok(companions.records[7].includes('太陽可是從西邊升起'));
  assert.ok(companions.records[8].includes('ＲＩＧＨＴ是左邊'));
  assert.ok(companions.records[8].includes('ＬＥＦＴ是右邊'));
  for (const [index, item] of [[11, '饅頭'], [12, '黍糰'], [13, '甘藷'], [14, '烤甘藷'], [15, '萬能丹']]) {
    assert.ok(companions.records[index].includes(item));
  }
  const hints = read('translations/gods-village-hints.draft.zh-Hant.json');
  assert.ok(hints.records[0].includes('比隆森林'));
  assert.ok(hints.records[4].includes('１０歲'));
  assert.ok(hints.records[4].includes('６０歲'));
});

test('Biron crystal draft excludes original unintelligible-script branches intentionally', () => {
  const draft = read('translations/biron-forest-crystal.draft.zh-Hant.json');
  const preserved = [8, 10, 12, 14, 16, 18, 20, 22];
  assert.equal(draft.complete, false);
  assert.equal(Object.keys(draft.records).length, 23 - preserved.length);
  for (const index of preserved) assert.equal(Object.hasOwn(draft.records, index), false);
  assert.equal(draft.records[3], draft.records[5]);
  assert.ok(draft.records[4].includes('月之水晶碎片'));
  assert.ok(draft.records[7].includes('露肚怪'));
});

test('Haradashi recruitment retains language skill, ordinary tail and meal pauses', () => {
  const draft = read('translations/haradashi-village-satokichi.draft.zh-Hant.json');
  assert.ok(draft.records[2].includes('一直往西'));
  assert.ok(draft.records[2].includes('金瘡仙人'));
  assert.ok(draft.records[3].includes('比隆的話'));
  assert.ok(draft.records[17].includes('蜥蜴尾巴'));
  assert.ok(!draft.records[17].includes('金蜥蜴'));
  for (const index of [9, 12]) assert.ok(draft.records[index].endsWith('[0b]'));
});

test('Biron village preserves untranslated language states and repeated kettle hints', () => {
  const draft = read('translations/haradashi-biron-dialogue.draft.zh-Hant.json');
  const preserved = [13, 15, 17, 19, 23, 24, 25, 29, 30, 31];
  assert.equal(draft.complete, false);
  assert.equal(Object.keys(draft.records).length, 32 - preserved.length);
  for (const index of preserved) assert.equal(Object.hasOwn(draft.records, index), false);
  assert.equal(draft.records[21], draft.records[27]);
  assert.equal(draft.records[22], draft.records[28]);
  assert.equal(draft.records[11].match(/\[09\]/g).length, 2);
  assert.ok(draft.records[26].includes('分福茶釜'));
  assert.ok(draft.records[26].includes('鬼爪痕'));
});

test('immortal retreat preserves popularity, eight immortals and southern seed route', () => {
  const draft = read('translations/immortal-retreat-guidance.draft.zh-Hant.json');
  assert.ok(draft.records[0].includes('勇氣鎧甲'));
  assert.ok(draft.records[1].includes('超過９０'));
  assert.ok(draft.records[1].includes('八位仙人'));
  assert.ok(draft.records[11].includes('天樹種子'));
  assert.ok(draft.records[13].includes('南邊的小島'));
});

test('Star Well preserves one wish per sword and separate limit branches', () => {
  const draft = read('translations/tanabata-star-well.draft.zh-Hant.json');
  assert.equal(draft.records[9], draft.records[13]);
  assert.ok(draft.records[9].includes('每一把劍'));
  assert.ok(draft.records[9].includes('只能實現一個願望'));
  assert.ok(draft.records[18].includes('最大技力'));
  assert.ok(draft.records[19].includes('到達極限'));
  assert.equal(draft.records[20], draft.records[21]);
  assert.equal(draft.records[22], '[09]的，\n[09]上升[0a]點！\n');
});

test('oni curses retain the step warning, repeated branches and battle terminators', () => {
  const draft = read('translations/oni-curses-and-breath.draft.zh-Hant.json');
  assert.ok(draft.records[8].includes('１２８步'));
  assert.ok(draft.records[3].includes('最大體力'));
  assert.ok(draft.records[9].includes('最大技力'));
  assert.equal(draft.records[1], draft.records[6]);
  assert.equal(draft.records[17], draft.records[19]);
  for (const text of Object.values(draft.records)) assert.ok(text.endsWith('[0f]'));
});

test('remaining chants select every v45 gap without duplicating released or empty records', () => {
  const draft = read('translations/spell-chants-remaining.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const index = catalog(rom, frozen, read('translations/opening.zh-Hant.json'));
  const block = index.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  const missing = block.records.filter(record => record.status === 'untranslated');
  assert.deepEqual(Object.keys(draft.records).map(Number), missing.map(record => record.index));
  assert.equal(block.records.filter(record => !record.originalHex).length, 52);
  const released = frozen.textBlocks.find(item => item.pointerOffset === draft.pointerOffset);
  assert.equal(released.entries.length, 15);
  for (const entry of compileTextDraft(rom, draft).entries) {
    assert.ok(!released.entries.some(previous => Number(previous.offset) === Number(entry.offset)));
  }
});

test('remaining battle events retain flavor pairs and exclude prior translations', () => {
  const draft = read('translations/battle-events-remaining.draft.zh-Hant.json');
  const screenshot = read('translations/screenshot-yashahime-battle.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const released = frozen.textBlocks.find(block => block.pointerOffset === draft.pointerOffset);
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json')).blocks.find(block => block.pointerOffset === draft.pointerOffset);
  const missing = source.records.filter(record => record.status === 'untranslated' && !Object.hasOwn(screenshot.records, record.index));
  assert.deepEqual(Object.keys(draft.records).map(Number), missing.map(record => record.index));
  for (const entry of compileTextDraft(rom, draft).entries) {
    assert.ok(!released.entries.some(previous => Number(previous.offset) === Number(entry.offset)));
  }
  for (const key of Object.keys(draft.records)) assert.ok(!Object.hasOwn(screenshot.records, key));
  for (let index = 43; index < 59; index += 2) assert.equal(draft.records[index], draft.records[index + 1]);
  assert.ok(draft.records[25].includes('３２次'));
  assert.ok(draft.records[68].includes('全員體力減半'));
  assert.ok(draft.records[72].includes('１４９２'));
  assert.ok(draft.records[88].includes('１５隻'));
  assert.ok(draft.records[88].includes('４４隻'));
  assert.ok(draft.records[94].includes('八五折'));
  assert.ok(draft.records[94].includes('３４００圓'));
  assert.ok(draft.records[98].includes('２星期'));
  assert.ok(draft.records[98].includes('１４人'));
  assert.ok(draft.records[100].includes('１００００圓'));
  assert.ok(draft.records[107].includes('風鈴'));
  assert.ok(draft.records[118].includes('雨中'));
  assert.ok(draft.records[120].includes('暴風中'));
  assert.ok(draft.records[121].includes('雷雨中'));
  assert.ok(draft.records[124].includes('暴風中'));
  assert.equal(draft.records[160].split('\n').length, 48);
  assert.ok(draft.records[160].includes('完全變成了石頭'));
  assert.ok(draft.records[168].includes('有心幫助閻魔大人'));
  assert.ok(draft.records[178].includes('友情的力量'));
  assert.ok(draft.records[197].includes('愛與勇氣'));
  assert.ok(draft.records[200].includes('玫瑰吹雪'));
  assert.equal(draft.records[200].match(/\[0f\]/g).length, 11);
});

test('common battle drafts preserve diagnostic controls and exclude prior translations', () => {
  const draft = read('translations/battle-messages-remaining.draft.zh-Hant.json');
  const screenshot = read('translations/screenshot-battle-status-escape.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const catalogued = catalog(rom, frozen, read('translations/opening.zh-Hant.json'));
  const source = catalogued.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  const diagnostics = [11, 12, 13, 16, 19, 47, 49, 52, 86, 92, 175];
  const missing = source.records.filter(record => record.status === 'untranslated'
    && !Object.hasOwn(screenshot.records, record.index) && record.index !== 11);
  assert.deepEqual(Object.keys(draft.records).map(Number), missing.map(record => record.index));
  assert.equal(catalogued.blocks[0].records[14].originalHex, 'a802b1');
  assert.equal(catalogued.blocks[0].records[17].originalHex, 'd6f7a1');
  for (const key of Object.keys(draft.records)) {
    assert.equal(source.records[Number(key)].status, 'untranslated');
    assert.ok(!Object.hasOwn(screenshot.records, key));
  }
  for (const index of diagnostics) {
    assert.ok(source.records[index].originalHex.startsWith('06'));
    if (index === 11) assert.ok(!Object.hasOwn(draft.records, index));
    else assert.ok(draft.records[index].startsWith('[06]'));
  }
  assert.ok(draft.records[39].includes('鬼道被封住'));
  assert.ok(draft.records[41].includes('又能使用鬼道'));
  assert.ok(draft.records[60].includes('掙脫了蜘蛛絲'));
  assert.ok(draft.records[67].includes('甩掉了一團團氣泡'));
  assert.ok(draft.records[74].includes('所有的術都無法使用'));
  assert.ok(draft.records[75].includes('所有的術都無法使用'));
  assert.ok(draft.records[109].includes('一半'));
  assert.ok(draft.records[111].includes('原封不動'));
  assert.ok(draft.records[110].includes('刺蝟玉'));
  assert.ok(draft.records[112].includes('豪豬玉'));
  assert.ok(draft.records[127].includes('說夢話'));
  assert.equal(draft.records[142], draft.records[143]);
  assert.ok(draft.records[149].includes('相同'));
  assert.ok(draft.records[162].includes('酷暑'));
  assert.ok(draft.records[163].includes('大晴天'));
  assert.ok(draft.records[166].includes('雷雨'));
  assert.ok(draft.records[168].includes('暴風雨'));
  assert.ok(draft.records[169].includes('[02ae]'));
  assert.ok(draft.records[169].includes('又能使用術'));
  assert.ok(draft.records[180].includes('變成０'));
});

test('remaining battle effects retain castle repairs and exclude released translations', () => {
  const draft = read('translations/battle-effects-remaining.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json')).blocks.find(block => block.pointerOffset === draft.pointerOffset);
  assert.deepEqual(Object.keys(draft.records).map(Number), source.records.filter(record => record.status === 'untranslated').map(record => record.index));
  for (const key of Object.keys(draft.records)) assert.equal(source.records[Number(key)].status, 'untranslated');
  assert.ok(draft.records[33].includes('３００'));
  assert.ok(draft.records[34].includes('完全回復'));
  assert.equal(draft.records[24], draft.records[27]);
  assert.equal(draft.records[5], draft.records[35]);
  assert.ok(draft.records[20].includes('十六文踢'));
  assert.ok(draft.records[64].includes('人氣低於\n３０'));
  assert.ok(draft.records[64].includes('不肯再吃黍糰'));
  assert.ok(draft.records[73].includes('敵我雙方'));
  assert.ok(draft.records[83].includes('金瘡膏'));
  assert.ok(draft.records[103].includes('兩倍'));
  assert.ok(draft.records[108].includes('戰鬥剛開始'));
  assert.ok(draft.records[111].includes('一千把冰刃'));
  assert.ok(draft.records[117].includes('十萬'));
  assert.ok(draft.records[120].includes('九十九段'));
  assert.ok(draft.records[146].includes('點技力'));
  assert.ok(draft.records[147].includes('分給'));
  assert.ok(draft.records[149].includes('投靠敵人'));
  assert.ok(draft.records[151].includes('酷暑'));
  assert.ok(draft.records[152].includes('體力最少'));
  assert.ok(draft.records[160].includes('最強'));
  assert.ok(draft.records[162].includes('漸強'));
});

test('shared dictionary retains bridge charges and nested spell-suffix identity', () => {
  const draft = read('translations/shared-dictionary-remaining.draft.zh-Hant.json');
  const compiled = compileTextDraft(rom, draft);
  for (const index of [2, 3, 5]) assert.ok(draft.records[index].includes('１００兩'));
  assert.equal(draft.records[14], '之術');
  assert.equal(draft.records[17], '術');
  assert.ok(compiled.entries.some(entry => entry.originalHex === 'a802b1'));
  assert.ok(compiled.entries.some(entry => entry.originalHex === 'd6f7a1'));
  assert.ok(!Object.hasOwn(draft.records, 0));
  assert.ok(!Object.hasOwn(draft.records, 10));
  for (const index of [7, 11, 23, 28, 29, 30, 33, 34, 35, 37, 38, 43, 49, 50, 51, 52, 53, 54, 55, 56, 57]) {
    assert.ok(!Object.hasOwn(draft.records, index));
  }
  assert.equal(draft.records[16], '金丹');
  assert.equal(draft.records[42], '夜叉姬');
  assert.equal(draft.records[46], '阿修羅');
  assert.equal(draft.records[39], '村');
  assert.ok(compiled.entries.some(entry => entry.originalHex === 'b0b6' && entry.segments.some(segment => segment.text === '村')));
});

test('final battle-message gap includes the developer note but preserves control-only records', () => {
  const draft = read('translations/boss-battle-final-message.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json'));
  const boss = source.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  assert.deepEqual(boss.records.filter(record => record.status === 'untranslated').map(record => record.index), [1, 50]);
  assert.equal(boss.records[1].originalHex, 'b3b6b99fa396a801a3979bf79bf8b7a4dd0f');
  assert.deepEqual(Object.keys(draft.records), ['1', '50']);
  assert.equal(draft.records[1], '被打倒時的\n特殊處理等[0f]');
  const spells = source.blocks.find(block => block.pointerOffset === '0x70042');
  assert.deepEqual(spells.records.filter(record => record.status === 'untranslated').map(record => record.originalHex), ['090f', '0f']);
});

test('remaining item and equipment names are source reserve slots, not new translations', () => {
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json'));
  for (const [pointer, count] of [['0x70015', 16], ['0x70018', 67]]) {
    const block = source.blocks.find(block => block.pointerOffset === pointer);
    const missing = block.records.filter(record => record.status === 'untranslated');
    assert.equal(missing.length, count);
    for (const record of missing) assert.match(record.originalHex, /1a4918205[1-9]$/);
  }
});

test('battle command labels retain released entries and compact weather distinctions', () => {
  const draft = read('translations/battle-command-labels-remaining.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json')).blocks.find(block => block.pointerOffset === draft.pointerOffset);
  for (const [index, text] of Object.entries(draft.records)) {
    assert.equal(source.records[Number(index)].status, 'untranslated');
    if (Number(index) < 35) assert.ok([...text].length <= 3);
  }
  const preserved = [0, 12, 22, 25, 27, 32, 34, 52, 53, 54, 58, 59, 60, 70, 71, 72, 73, 74, 75, 88, 89, 91, 92];
  for (const index of preserved) assert.ok(!Object.hasOwn(draft.records, index));
  assert.deepEqual(Object.keys(draft.records).map(Number), source.records
    .filter(record => record.status === 'untranslated' && !preserved.includes(record.index)).map(record => record.index));
  assert.equal(draft.records[18], '酷暑');
  assert.equal(draft.records[19], '大晴天');
  assert.equal(draft.records[20], '晴天');
  assert.equal(draft.records[24], '暴風雨');
  assert.equal(draft.records[14], draft.records[28]);
  assert.equal(draft.records[15], draft.records[29]);
  for (const [index, answer] of [[44, '１６８小時'], [48, '２０１棵'], [50, '７隻'],
    [55, '５節車廂６００人'], [56, '６節車廂６９０人'], [63, '時速６０公里'],
    [68, '４０００圓'], [77, '時速６０公里'], [81, '８天'], [83, '３６和１２'], [87, '７５００圓']]) {
    assert.equal(draft.records[index], answer);
  }
});

test('character labels reuse story names without changing default animal names', () => {
  const draft = read('translations/character-labels-remaining.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json')).blocks.find(block => block.pointerOffset === draft.pointerOffset);
  for (const [index, text] of Object.entries(draft.records)) {
    assert.equal(source.records[Number(index)].status, 'untranslated');
    assert.ok([...text].length <= 4);
  }
  for (const index of [1, 2, 3, 6, 7, 13, 21, 22, 23, 24]) assert.ok(!Object.hasOwn(draft.records, index));
  assert.equal(source.records[8].originalHex, '0496bde2df03');
  assert.equal(draft.records[8], '貧窮大王');
  assert.equal(source.records[65].originalHex, '941891');
  assert.equal(draft.records[65], '阿文');
  assert.equal(draft.records[11], '寢太郎');
  assert.equal(draft.records[12], '大太郎');
  assert.equal(draft.records[14], '露肚怪');
  assert.equal(draft.records[20], '十一屋');
});

test('item readings match released item names without replacing released readings', () => {
  const draft = read('translations/item-readings-remaining.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json'));
  const names = source.blocks.find(block => block.pointerOffset === '0x70015');
  const readings = source.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  assert.equal(draft.records[40], '修城[02b2]');
  assert.equal(readings.records[40].originalHex, '9bba9bf792b702b2');
  assert.equal(draft.records[155], '[02b9]之鏡');
  assert.ok(readings.records[155].originalHex.startsWith('02b9'));
  const reserves = [69, 70, 80, 81, 86, 87, 88, 101, 102, 103, 125, 126, 127, 128, 129, 130];
  for (const index of reserves) {
    assert.equal(readings.records[index].originalHex, 'b5df');
    assert.ok(!Object.hasOwn(draft.records, index));
  }
  assert.equal(readings.records.filter(record => record.status === 'empty').length, 7);
  assert.deepEqual(Object.keys(draft.records).map(Number), readings.records
    .filter(record => record.status === 'untranslated' && !reserves.includes(record.index))
    .map(record => record.index));
  for (const [index, text] of Object.entries(draft.records)) {
    assert.equal(readings.records[Number(index)].status, 'untranslated');
    const dictionary = read('translations/shared-dictionary-remaining.draft.zh-Hant.json').records;
    const composed = text.replaceAll('[02b9]', dictionary[25]).replaceAll('[02b2]', dictionary[18]);
    assert.equal(composed, index === '40' ? '修城道具' : names.records[Number(index)].translation);
    assert.ok([...composed].length <= 8);
  }
  const released = read('translations/font-alignment-v50.release.json');
  const current = catalog(rom, released, read('translations/opening.zh-Hant.json'));
  const releasedText = record => record.translation ?? record.segments.map(segment => segment.text ?? `[${segment.hex}]`).join('');
  assert.equal(releasedText(current.blocks.find(block => block.pointerOffset === '0x70000').records[18]), '道具');
  const previous = current.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  for (const [index, text] of Object.entries(draft.records)) {
    if (index === '40') assert.equal(previous.records[40].status, 'untranslated');
    else assert.equal(text, releasedText(previous.records[Number(index)]));
  }
  assert.equal(names.records[40].translation, '修城工具');
});

test('v51 remaining review counts unresolved callers without treating absent references as unused', async () => {
  const { dictionaryReferences, reviewRemainingText } = await import('../tools/remaining-text-review.mjs');
  assert.deepEqual(dictionaryReferences(Buffer.from('1802190202be02be', 'hex')), [30, 30]);
  assert.throws(() => dictionaryReferences(Buffer.from('02', 'hex')), /Truncated/);
  assert.throws(() => dictionaryReferences(Buffer.from('18', 'hex')), /Truncated/);
  const review = reviewRemainingText(rom, read('translations/followup-v51.release.json'), read('translations/opening.zh-Hant.json'));
  assert.equal(review.summary.translatedRecords, 7081);
  assert.equal(review.summary.untranslatedRecords, 707);
  assert.equal(review.callerReviewRecords, 177);
  assert.equal(review.otherRecords, 530);
  const dictionary = review.tables.find(table => table.pointerOffset === '0x70000');
  const fragment = dictionary.records.find(record => record.index === 30);
  assert.ok(fragment.sourceIndexedCallers.some(caller => caller.pointerOffset === '0x7004b' && caller.index === 98));
  assert.equal(fragment.runtimeCallersVerified, false);
  assert.equal(review.completeTranslation, false);
  assert.equal(review.tables.find(table => table.pointerOffset === '0x70033').records.length, 194);
  assert.equal(review.tables.find(table => table.pointerOffset === '0x7001e').records.length, 16);
});

test('remaining review distinguishes protected data from input and caller work without inflating coverage', async () => {
  const { reviewRemainingText } = await import('../tools/remaining-text-review.mjs');
  const manifest = read('opening-preview-v60/resolved-translation-manifest.json');
  const review = reviewRemainingText(rom, manifest, read('translations/opening.zh-Hant.json'));
  assert.equal(review.summary.translatedRecords, 7083);
  assert.equal(review.summary.untranslatedRecords, 705);
  assert.equal(Object.values(review.workKinds).reduce((total, count) => total + count, 0), 705);
  assert.equal(review.workKinds['preserve-alphanumeric'], 36);
  assert.equal(review.workKinds['preserve-reserved-slot'], 166);
  assert.equal(review.workKinds['input-system-review'], 194);
  assert.equal(review.workKinds['preserve-credit-attribution'], 79);
  assert.equal(review.workKinds['preserve-fictional-language'], 18);
  assert.equal(review.workKinds['diagnostic-caller-review'], 12);
  assert.equal(review.completeTranslation, false);
  assert.ok(review.tables.every(table => table.records.every(record => record.workKind && record.originalHex)));
});

test('v47 residual review accounts for every unselected table without counting it as translated', () => {
  const plan = read('translations/remaining-v47.plan.json');
  const review = plan.residualReview;
  const source = catalog(rom, read(plan.manifest), read('translations/opening.zh-Hant.json'));
  const remaining = source.blocks.map(block => ({ pointerOffset: block.pointerOffset,
    count: block.records.filter(record => record.status === 'untranslated').length })).filter(block => block.count);
  assert.deepEqual(review.tables.map(({ pointerOffset, count }) => ({ pointerOffset, count })), remaining);
  assert.equal(review.notACompletionClaim, true);
  assert.equal(source.summary.translatedRecords, review.includedRecords);
  assert.equal(source.summary.untranslatedRecords, review.unselectedRecords);
  assert.equal(source.summary.emptyRecords, review.emptyRecords);
  assert.equal(review.includedRecords, 4645 + plan.addedIndexedEntries);
  assert.equal(review.includedRecords + review.unselectedRecords + review.emptyRecords, 7870);
  assert.ok(review.tables.every(table => table.reason && ['caller-review', 'preserve-source', 'mixed'].includes(table.disposition)));
});

test('equipment readings match released equipment without changing reserves or dictionary controls', () => {
  const draft = read('translations/equipment-readings-remaining.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json'));
  const names = source.blocks.find(block => block.pointerOffset === '0x70018');
  const readings = source.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  const reserves = readings.records.filter(record => record.originalHex === 'b5df');
  assert.equal(reserves.length, 67);
  for (const record of reserves) {
    assert.equal(names.records[record.index].status, 'untranslated');
    assert.ok(!Object.hasOwn(draft.records, record.index));
  }
  for (const index of [13, 14, 15, 31, 216, 230]) {
    assert.ok(readings.records[index].originalHex.startsWith('02b9'));
    assert.ok(draft.records[index].startsWith('[02b9]'));
  }
  for (const index of [59, 69]) {
    assert.ok(readings.records[index].originalHex.startsWith('02b8'));
    assert.ok(draft.records[index].startsWith('[02b8]'));
  }
  assert.equal(readings.records.filter(record => record.status === 'empty').length, 1);
  assert.deepEqual(Object.keys(draft.records).map(Number), readings.records
    .filter(record => record.status === 'untranslated' && record.originalHex !== 'b5df')
    .map(record => record.index));
  for (const [index, text] of Object.entries(draft.records)) {
    assert.equal(readings.records[Number(index)].status, 'untranslated');
    const dictionary = read('translations/shared-dictionary-remaining.draft.zh-Hant.json').records;
    const composed = text.replaceAll('[02b9]', dictionary[25]).replaceAll('[02b8]', dictionary[24]);
    assert.equal(composed, names.records[Number(index)].translation);
    assert.ok([...composed].length <= 8);
  }
});

test('technique readings reuse released spell names and preserve existing raw entries', () => {
  const draft = read('translations/technique-readings-remaining.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json'));
  const names = source.blocks.find(block => block.pointerOffset === '0x7001b');
  const readings = source.blocks.find(block => block.pointerOffset === draft.pointerOffset);
  for (const [index, text] of Object.entries(draft.records)) {
    assert.equal(readings.records[Number(index)].status, 'untranslated');
    assert.equal(text, names.records[Number(index)].translation);
    assert.ok([...text].length <= 8);
  }
  for (const entry of compileTextDraft(rom, draft).entries) {
    assert.ok(!frozen.entries.some(previous => Number(previous.offset) === Number(entry.offset)));
  }
  const released = read('opening-preview-v46/resolved-translation-manifest.json').textBlocks
    .find(block => block.pointerOffset === draft.pointerOffset);
  const compiled = compileTextDraft(rom, draft);
  assert.deepEqual(compiled.entries.slice(0, 10), released.entries);
  assert.deepEqual(Object.keys(draft.records).map(Number), Array.from({ length: 93 }, (_, index) => index + 1));
  assert.equal(readings.records[0].originalHex, '');
});

test('common status labels preserve existing stats and split-name source records', () => {
  const draft = read('translations/common-status-labels-remaining.draft.zh-Hant.json');
  const frozen = read('opening-preview-v45/resolved-translation-manifest.json');
  const source = catalog(rom, frozen, read('translations/opening.zh-Hant.json')).blocks.find(block => block.pointerOffset === draft.pointerOffset);
  for (const [index, text] of Object.entries(draft.records)) {
    assert.equal(source.records[Number(index)].status, 'untranslated');
    if (Number(index) < 100) assert.ok([...text.replace(/\[0[68]\]/g, '')].length <= (index === '20' ? 5 : 4));
  }
  for (const index of [12, 13, 14, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45]) assert.ok(!Object.hasOwn(draft.records, index));
  for (const entry of compileTextDraft(rom, draft).entries) {
    assert.ok(!frozen.entries.some(previous => Number(previous.offset) === Number(entry.offset)));
  }
  assert.equal(draft.records[9], draft.records[22]);
  assert.equal(draft.records[11], draft.records[23]);
  assert.equal(draft.records[15], '[08]身高');
  assert.equal(draft.records[32], '日');
  assert.ok(draft.records[16].startsWith('[08]'));
  assert.ok(draft.records[20].startsWith('[08] '));
  for (const index of [27, 28]) assert.ok(draft.records[index].startsWith('[06]'));
  for (const index of [149, 150]) assert.ok(draft.records[index].startsWith('[07]'));
  assert.ok(draft.records[118].startsWith('  [02a0]'));
  assert.ok(draft.records[120].includes('傳達愛與勇氣'));
  assert.ok(draft.records[123].includes('被詛咒'));
  assert.equal(draft.records[124], '現在不能更換！');
  assert.equal(source.records[124].originalHex, '187ba9509593b6b9a4915c');
  const caller = Buffer.from('ad07038904f008a97c22b9a084800fade412aabf3bf1818d5a15', 'hex');
  assert.deepEqual(rom.subarray(0x1f115, 0x1f115 + caller.length), caller);
  assert.equal(rom.subarray(0x4a0b9, 0x4a0c1).toString('hex'), '8db512a9028db412');
  const installed = catalog(rom, read('opening-preview-v48/resolved-translation-manifest.json'), read('translations/opening.zh-Hant.json'));
  assert.equal(installed.blocks.find(block => block.pointerOffset === draft.pointerOffset).records[124].status, 'untranslated');
  for (let index = 151; index <= 160; index++) assert.ok(draft.records[index].startsWith('[08]'));
  assert.ok(draft.records[153].startsWith('[08] '));
  for (const index of [156, 157]) assert.ok(draft.records[index].startsWith('[08]  '));
  for (const index of [158, 159, 160]) assert.ok(draft.records[index].startsWith('[08]   '));
  for (const index of [163, 164, 166, 167, 170]) assert.ok(!Object.hasOwn(draft.records, index));
  for (const [index, originalHex, text] of [
    [165, '18811a031892', '娥眉月'],
    [168, '18ca1886', '十九夜'],
    [169, '185d1886', '十八夜'],
  ]) {
    assert.equal(source.records[index].originalHex, originalHex);
    assert.equal(draft.records[index], text);
    assert.equal([...text].length, 3);
  }
  assert.equal(draft.records[171], '滿月');
  assert.equal(draft.records[175], '會心一擊次數');
  assert.equal(draft.records[176], '痛恨一擊次數');
  assert.equal(draft.records[178], '動畫');
});

test('native name-entry contract guards all twelve fixed storage modes', async () => {
  const { nameEntryContract } = await import('../tools/verify-name-entry.mjs');
  const modes = nameEntryContract(rom);
  assert.deepEqual(modes.map(mode => mode.address), [
    0x3d36, 0x3d3c, 0x3d42, 0x3d2b, 0x3d30, 0x3d4b,
    0x3d50, 0x3d55, 0x3d5a, 0x3d5f, 0x3d64, 0x5f4a,
  ]);
  assert.deepEqual(modes.map(mode => mode.capacity), [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5]);
  assert.deepEqual(modes.filter(mode => mode.katakana).map(mode => mode.mode), [1, 2, 3]);
  const changed = Buffer.from(rom);
  changed[0x5d569] ^= 1;
  assert.throws(() => nameEntryContract(changed));
});

test('fixed nickname 30 preserves the original Aomaya syllable order', () => {
  const draft = read('translations/character-labels-remaining.draft.zh-Hant.json');
  assert.equal(draft.records[30], '阿歐瑪亞');
  const entry = compileTextDraft(rom, draft).entries.find(record => record.originalHex === '049094aeb303');
  assert.ok(entry);
  assert.equal(entry.segments.filter(segment => segment.text).map(segment => segment.text).join(''), '阿歐瑪亞');
});
