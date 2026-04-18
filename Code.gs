/**
 * ================================================================
 * KY 재고관리 시스템 - Google Apps Script 웹앱
 * ================================================================
 *
 * [설정 방법]
 * 1. Google Sheets에서 확장 프로그램 > Apps Script 실행
 * 2. 이 코드 전체를 붙여넣기
 * 3. SPREADSHEET_ID를 실제 스프레드시트 ID로 교체
 *    (URL에서 /d/ 와 /edit 사이의 문자열)
 * 4. 저장 후 [배포] > [새 배포] > 웹앱으로 배포
 *    - 실행 계정: 나
 *    - 액세스 권한: 모든 사용자 (또는 조직 내)
 * 5. 배포 URL을 복사해서 프론트엔드 설정 탭에 입력
 *
 * [시트 구조 요구사항]
 * 시트1: 재고 입출고 입력(응답)
 *   컬럼: 타임스탬프 | 바코드  | 수량 | 구분 | 창고 | 현장명 | 담당자
 *
 * 시트2: 품목마스터 (없으면 자동 생성)
 *   컬럼: barcode | item_name | spec | unit | safety_stock | location | note
 * ================================================================
 */

// ────────────────────────────────────────────────
// ★ 여기만 수정하세요 ★
var SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';
// ────────────────────────────────────────────────

var TRANS_SHEET_NAME  = '재고 입출고 입력(응답)';
var MASTER_SHEET_NAME = '품목마스터';

// ================================================================
// CORS 헤더 설정
// ================================================================
function setCorsHeaders(output) {
  return output
    .setMimeType(ContentService.MimeType.JSON)
    .addHeader('Access-Control-Allow-Origin', '*')
    .addHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    .addHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function jsonResponse(data) {
  return setCorsHeaders(
    ContentService.createTextOutput(JSON.stringify(data))
  );
}

// ================================================================
// GET 요청 라우터
// ================================================================
function doGet(e) {
  try {
    var action = e.parameter.action || '';

    if (action === 'ping') {
      return jsonResponse({ status: 'ok', message: 'KY 재고관리 시스템 API 정상 작동 중' });
    }
    if (action === 'getMaster') {
      return jsonResponse(getMaster());
    }
    if (action === 'getItemByBarcode') {
      var bc = e.parameter.barcode || '';
      return jsonResponse(getItemByBarcode(bc));
    }
    if (action === 'getStock') {
      return jsonResponse(getStock());
    }
    if (action === 'getHistory') {
      var from    = e.parameter.from    || '';
      var to      = e.parameter.to      || '';
      var barcode = e.parameter.barcode || '';
      var type    = e.parameter.type    || '';
      var wh      = e.parameter.warehouse || '';
      var site    = e.parameter.site    || '';
      var manager = e.parameter.manager || '';
      return jsonResponse(getHistory(from, to, barcode, type, wh, site, manager));
    }
    if (action === 'getShortage') {
      return jsonResponse(getShortage());
    }
    if (action === 'getDashboard') {
      return jsonResponse(getDashboard());
    }

    return jsonResponse({ error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

// ================================================================
// POST 요청 라우터
// ================================================================
function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action || '';

    if (action === 'saveTransaction') {
      return jsonResponse(saveTransaction(body));
    }
    if (action === 'saveMasterItem') {
      return jsonResponse(saveMasterItem(body));
    }
    if (action === 'updateMasterItem') {
      return jsonResponse(updateMasterItem(body));
    }
    if (action === 'deleteMasterItem') {
      return jsonResponse(deleteMasterItem(body.barcode));
    }

    return jsonResponse({ error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ================================================================
// 스프레드시트 & 시트 접근
// ================================================================
function getSpreadsheet() {
  if (SPREADSHEET_ID === 'YOUR_SPREADSHEET_ID_HERE') {
    throw new Error('SPREADSHEET_ID를 실제 스프레드시트 ID로 교체해 주세요.');
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getTransSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName(TRANS_SHEET_NAME);
  if (!sh) throw new Error('시트를 찾을 수 없습니다: ' + TRANS_SHEET_NAME);
  return sh;
}

function getMasterSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName(MASTER_SHEET_NAME);
  if (!sh) {
    // 없으면 자동 생성
    sh = ss.insertSheet(MASTER_SHEET_NAME);
    sh.appendRow(['barcode','item_name','spec','unit','safety_stock','location','note']);
    sh.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
    SpreadsheetApp.flush();
  }
  return sh;
}

// ================================================================
// 공통 유틸
// ================================================================
function sheetToObjects(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0].map(function(h){ return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      // 날짜 객체 → 문자열 변환
      if (val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      }
      row[headers[j]] = val === null || val === undefined ? '' : val;
    }
    rows.push(row);
  }
  return rows;
}

function formatNow() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function safeStr(v) { return v !== null && v !== undefined ? String(v).trim() : ''; }
function safeNum(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

// ================================================================
// 1. 품목마스터 전체 조회
// ================================================================
function getMaster() {
  var sh   = getMasterSheet();
  var rows = sheetToObjects(sh);
  return {
    status : 'ok',
    count  : rows.length,
    data   : rows.map(function(r) {
      return {
        barcode      : safeStr(r['barcode']),
        item_name    : safeStr(r['item_name']),
        spec         : safeStr(r['spec']),
        unit         : safeStr(r['unit']),
        safety_stock : safeNum(r['safety_stock']),
        location     : safeStr(r['location']),
        note         : safeStr(r['note'])
      };
    })
  };
}

// ================================================================
// 2. 바코드로 품목 단건 조회
// ================================================================
function getItemByBarcode(barcode) {
  var bc   = safeStr(barcode);
  var rows = sheetToObjects(getMasterSheet());
  var item = rows.find(function(r){ return safeStr(r['barcode']) === bc; });
  if (!item) return { status: 'notfound', barcode: bc };
  return {
    status   : 'ok',
    barcode  : safeStr(item['barcode']),
    item_name: safeStr(item['item_name']),
    spec     : safeStr(item['spec']),
    unit     : safeStr(item['unit']),
    safety_stock: safeNum(item['safety_stock']),
    location : safeStr(item['location']),
    note     : safeStr(item['note'])
  };
}

// ================================================================
// 3. 입출고 트랜잭션 저장
// ================================================================
function saveTransaction(body) {
  var sh = getTransSheet();

  var ts      = safeStr(body.timestamp) || formatNow();
  var barcode = safeStr(body.barcode);
  var qty     = safeNum(body.quantity);
  var type    = safeStr(body.type);
  var wh      = safeStr(body.warehouse);
  var site    = safeStr(body.site);
  var manager = safeStr(body.manager);
  var note    = safeStr(body.note);

  // 기본 유효성 검사
  if (!barcode) return { status: 'error', message: '바코드가 없습니다.' };
  if (!qty || qty < 1) return { status: 'error', message: '수량이 잘못되었습니다.' };
  if (type !== '입고' && type !== '출고') return { status: 'error', message: '구분(입고/출고)이 잘못되었습니다.' };
  if (!wh) return { status: 'error', message: '창고를 선택해 주세요.' };

  sh.appendRow([ts, barcode, qty, type, wh, site, manager, note]);
  SpreadsheetApp.flush();

  return { status: 'ok', message: '저장 완료', timestamp: ts };
}

// ================================================================
// 4. 재고 집계 조회
// ================================================================
function getStock() {
  var masterRows = sheetToObjects(getMasterSheet());
  var transRows  = getTransRows();

  // 창고별 재고 집계 맵 구성
  var stockMap = {};
  masterRows.forEach(function(m) {
    var bc = safeStr(m['barcode']);
    stockMap[bc] = { total: 0, seongso: 0, hyunpung: 0 };
  });

  transRows.forEach(function(tx) {
    var bc  = safeStr(tx['바코드']) || safeStr(tx['barcode']);
    var qty = safeNum(tx['수량']   || tx['quantity']);
    var typ = safeStr(tx['구분']   || tx['type']);
    var wh  = safeStr(tx['창고']   || tx['warehouse']);

    if (!stockMap[bc]) stockMap[bc] = { total: 0, seongso: 0, hyunpung: 0 };

    var delta = typ === '입고' ? qty : -qty;
    stockMap[bc].total += delta;
    if (wh === '성서공장')  stockMap[bc].seongso  += delta;
    if (wh === '현풍공장')  stockMap[bc].hyunpung += delta;
  });

  var result = masterRows.map(function(m) {
    var bc = safeStr(m['barcode']);
    var s  = stockMap[bc] || { total: 0, seongso: 0, hyunpung: 0 };
    return {
      barcode      : bc,
      item_name    : safeStr(m['item_name']),
      spec         : safeStr(m['spec']),
      unit         : safeStr(m['unit']),
      safety_stock : safeNum(m['safety_stock']),
      location     : safeStr(m['location']),
      total        : s.total,
      seongso      : s.seongso,
      hyunpung     : s.hyunpung,
      is_short     : s.total < safeNum(m['safety_stock'])
    };
  });

  return { status: 'ok', count: result.length, data: result };
}

// ================================================================
// 5. 입출고 이력 조회 (필터 포함)
// ================================================================
function getTransRows() {
  var sh   = getTransSheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];

  // 컬럼 인덱스 찾기 (헤더 기준)
  var headers = data[0].map(function(h){ return String(h).trim(); });
  var idx = {};
  headers.forEach(function(h, i){ idx[h] = i; });

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var tsVal = row[idx['타임스탬프']];
    var ts = tsVal instanceof Date
      ? Utilities.formatDate(tsVal, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss')
      : safeStr(tsVal);

    // 바코드 컬럼: '바코드 '(공백 포함) 또는 'barcode'
    var bcKey  = idx.hasOwnProperty('바코드 ') ? '바코드 '
               : idx.hasOwnProperty('바코드')  ? '바코드'
               : 'barcode';
    var barcode = safeStr(row[idx[bcKey] !== undefined ? idx[bcKey] : idx['barcode'] || 0]);

    rows.push({
      timestamp : ts,
      barcode   : barcode,
      quantity  : safeNum(row[idx['수량']   !== undefined ? idx['수량']   : idx['quantity']]),
      type      : safeStr(row[idx['구분']   !== undefined ? idx['구분']   : idx['type']]),
      warehouse : safeStr(row[idx['창고']   !== undefined ? idx['창고']   : idx['warehouse']]),
      site      : safeStr(row[idx['현장명'] !== undefined ? idx['현장명'] : idx['site']] || ''),
      manager   : safeStr(row[idx['담당자'] !== undefined ? idx['담당자'] : idx['manager']] || ''),
      note      : ''
    });
  }
  return rows.reverse(); // 최신순
}

function getHistory(from, to, barcode, type, warehouse, site, manager) {
  var rows = getTransRows();

  // 마스터와 조인하여 품목명 추가
  var masterMap = {};
  sheetToObjects(getMasterSheet()).forEach(function(m){
    masterMap[safeStr(m['barcode'])] = m;
  });

  var filtered = rows.filter(function(r) {
    var ds = r.timestamp.slice(0, 10);
    if (from && ds < from) return false;
    if (to   && ds > to)   return false;
    if (barcode && r.barcode.toLowerCase().indexOf(barcode.toLowerCase()) < 0) return false;
    if (type    && r.type      !== type)      return false;
    if (warehouse && r.warehouse !== warehouse) return false;
    if (site    && r.site.toLowerCase().indexOf(site.toLowerCase()) < 0) return false;
    if (manager && r.manager.toLowerCase().indexOf(manager.toLowerCase()) < 0) return false;
    return true;
  });

  var data = filtered.map(function(r) {
    var m = masterMap[r.barcode] || {};
    return {
      timestamp : r.timestamp,
      barcode   : r.barcode,
      item_name : safeStr(m['item_name']) || r.barcode,
      spec      : safeStr(m['spec'])      || '',
      unit      : safeStr(m['unit'])      || '',
      type      : r.type,
      quantity  : r.quantity,
      warehouse : r.warehouse,
      site      : r.site,
      manager   : r.manager,
      note      : r.note
    };
  });

  var inSum  = data.filter(function(r){return r.type==='입고';}).reduce(function(s,r){return s+r.quantity;},0);
  var outSum = data.filter(function(r){return r.type==='출고';}).reduce(function(s,r){return s+r.quantity;},0);

  return { status:'ok', count: data.length, in_sum: inSum, out_sum: outSum, data: data };
}

// ================================================================
// 6. 부족재고 조회
// ================================================================
function getShortage() {
  var stock = getStock();
  var shortage = (stock.data || []).filter(function(r){ return r.is_short; })
    .sort(function(a, b){
      return (a.total - a.safety_stock) - (b.total - b.safety_stock);
    })
    .map(function(r) {
      return {
        barcode      : r.barcode,
        item_name    : r.item_name,
        spec         : r.spec,
        unit         : r.unit,
        safety_stock : r.safety_stock,
        total        : r.total,
        seongso      : r.seongso,
        hyunpung     : r.hyunpung,
        shortage_qty : r.safety_stock - r.total,
        location     : r.location
      };
    });
  return { status: 'ok', count: shortage.length, data: shortage };
}

// ================================================================
// 대시보드 집계
// ================================================================
function getDashboard() {
  var stock    = getStock();
  var master   = getMaster();
  var today    = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var transRows = getTransRows();

  var todayRows = transRows.filter(function(r){ return r.timestamp.indexOf(today) === 0; });
  var inToday   = todayRows.filter(function(r){ return r.type === '입고'; }).length;
  var outToday  = todayRows.filter(function(r){ return r.type === '출고'; }).length;

  var totalQty  = 0, seongsoTotal = 0, hyunpungTotal = 0, shortCount = 0;
  (stock.data || []).forEach(function(r){
    totalQty     += r.total;
    seongsoTotal += r.seongso;
    hyunpungTotal+= r.hyunpung;
    if (r.is_short) shortCount++;
  });

  // 최근 10건
  var recentMasterMap = {};
  (master.data || []).forEach(function(m){ recentMasterMap[m.barcode] = m; });
  var recent10 = transRows.slice(0, 10).map(function(r){
    var m = recentMasterMap[r.barcode] || {};
    return {
      timestamp : r.timestamp,
      barcode   : r.barcode,
      item_name : safeStr(m['item_name']) || r.barcode,
      unit      : safeStr(m['unit']) || '',
      type      : r.type,
      quantity  : r.quantity,
      warehouse : r.warehouse,
      manager   : r.manager
    };
  });

  return {
    status         : 'ok',
    today          : today,
    total_items    : master.count,
    total_qty      : totalQty,
    seongso_qty    : seongsoTotal,
    hyunpung_qty   : hyunpungTotal,
    shortage_count : shortCount,
    in_today       : inToday,
    out_today      : outToday,
    recent10       : recent10
  };
}

// ================================================================
// 품목마스터 저장 / 수정 / 삭제
// ================================================================
function saveMasterItem(body) {
  var sh      = getMasterSheet();
  var barcode = safeStr(body.barcode);
  if (!barcode) return { status: 'error', message: '바코드가 없습니다.' };

  // 중복 체크
  var rows = sheetToObjects(sh);
  var exists = rows.some(function(r){ return safeStr(r['barcode']) === barcode; });
  if (exists) return { status: 'error', message: '이미 등록된 바코드입니다: ' + barcode };

  sh.appendRow([
    barcode,
    safeStr(body.item_name),
    safeStr(body.spec),
    safeStr(body.unit),
    safeNum(body.safety_stock),
    safeStr(body.location),
    safeStr(body.note)
  ]);
  SpreadsheetApp.flush();
  return { status: 'ok', message: '품목 등록 완료' };
}

function updateMasterItem(body) {
  var sh      = getMasterSheet();
  var barcode = safeStr(body.barcode);
  var data    = sh.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (safeStr(data[i][0]) === barcode) {
      sh.getRange(i+1, 1, 1, 7).setValues([[
        barcode,
        safeStr(body.item_name),
        safeStr(body.spec),
        safeStr(body.unit),
        safeNum(body.safety_stock),
        safeStr(body.location),
        safeStr(body.note)
      ]]);
      SpreadsheetApp.flush();
      return { status: 'ok', message: '품목 수정 완료' };
    }
  }
  return { status: 'error', message: '해당 바코드를 찾을 수 없습니다: ' + barcode };
}

function deleteMasterItem(barcode) {
  var sh   = getMasterSheet();
  var bc   = safeStr(barcode);
  var data = sh.getDataRange().getValues();

  for (var i = data.length - 1; i >= 1; i--) {
    if (safeStr(data[i][0]) === bc) {
      sh.deleteRow(i + 1);
      SpreadsheetApp.flush();
      return { status: 'ok', message: '품목 삭제 완료' };
    }
  }
  return { status: 'error', message: '해당 바코드를 찾을 수 없습니다: ' + bc };
}
