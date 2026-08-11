// ==================================================================
// Power BI Bridge API — واجهة وسيطة تُنشَر كـFirebase Cloud Function،
// تقرأ بيانات نظام المحاسبة (accounting.html) من نفس مستند Firestore الذي
// تُزامِنه cloud-sync.js، وتعرضها كجداول JSON منظَّمة عبر HTTP يستطيع
// Power BI الاتصال بها مباشرة (Get Data ← Web).
//
// لا تُنشَر هذه الدالة تلقائياً — يجب نشرها يدوياً من حساب Firebase الخاص
// بك (راجع README.md بهذا المجلد للخطوات الكاملة).
//
// تنبيه مهم: بعض المنطق هنا (خصوصاً getEntryBranchId) هو نسخة موازية من
// نفس القاعدة المُطبَّقة داخل accounting.html — أي تعديل مستقبلي لقاعدة
// تصنيف الفروع هناك يجب تكراره هنا يدوياً وإلا اختلفت النتائج بين
// التطبيق نفسه وتقارير Power BI.
// ==================================================================

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({origin: true}));

// ── الأمان: مفتاح API إلزامي بترويسة x-api-key ──
// عيّن القيمة عبر: firebase functions:config:set powerbi.apikey="قيمة-سرية-طويلة"
// (أو، بأحدث إصدارات firebase-functions، متغيّر بيئة عبر .env — راجع README.md)
// بيانات محاسبية حقيقية — لا تُنشر هذه الواجهة بدون مفتاح إطلاقاً.
function requireApiKey(req, res, next) {
  const configured = (functions.config().powerbi && functions.config().powerbi.apikey) || process.env.POWERBI_API_KEY;
  if (!configured) {
    res.status(500).json({error: 'لم يُعيَّن مفتاح API بعد على الخادم — راجع README.md'});
    return;
  }
  const provided = req.get('x-api-key');
  if (provided !== configured) {
    res.status(401).json({error: 'مفتاح API غير صحيح أو مفقود (ترويسة x-api-key)'});
    return;
  }
  next();
}
app.use(requireApiKey);

// ── تحميل بيانات الشركة من Firestore ──
// نفس منطق تسمية المستند الموجود بـaccounting.html (CLOUD_DOC_NAME):
// 'accounting' للشركة الافتراضية، أو 'accounting_<companyId>' لأي شركة أخرى
async function loadCompanyData(company) {
  const docName = !company || company === 'default' ? 'accounting' : 'accounting_' + company;
  const snap = await db.collection('system').doc(docName).get();
  if (!snap.exists) return null;
  const d = snap.data();
  if (!d || !d.data) return null;
  try {
    return JSON.parse(d.data);
  } catch (e) {
    return null;
  }
}

// ── دوال مساعدة — منسوخة عمداً (وليست مستوردة) من accounting.html لأن
// هذه دالة سحابية منفصلة تماماً لا تُحمِّل الملف الأصلي ──
const NORM = {asset: 'dr', liability: 'cr', equity: 'cr', revenue: 'cr', cost: 'dr', expense: 'dr'};

function isLeaf(accounts, id) {
  return !accounts.some(a => a.par === id);
}

function postedEntries(entries) {
  return (entries || []).filter(e => !e.isDraft);
}

// راجع getEntryBranchId داخل accounting.html — يجب أن يبقى هذا مطابقاً له تماماً
function getEntryBranchId(e, branches, costCenters) {
  if (e.branchOverride && branches.some(b => b.id === e.branchOverride)) return e.branchOverride;
  const riyadh = branches.find(b => b.name === 'الرياض');
  const jeddah = branches.find(b => b.name === 'جدة');
  const riyadhCCRe = /بلاك\s*نايت|الرياض/;
  const hasRiyadhCC = (e.lines || []).some(l => {
    if (!l.costCenterId) return false;
    const cc = costCenters.find(c => c.id === l.costCenterId);
    return cc && riyadhCCRe.test(cc.name || '');
  });
  const hasIbrahimCustody = /ابراهيم/.test(e.desc || '') || (e.lines || []).some(l => /ابراهيم/.test(l.desc || ''));
  if (hasRiyadhCC || hasIbrahimCustody) return riyadh ? riyadh.id : null;
  return jeddah ? jeddah.id : null;
}

function dateFilter(req) {
  const from = req.query.from || '';
  const to = req.query.to || '';
  return e => (!from || e.date >= from) && (!to || e.date <= to);
}

function notFoundIfMissing(data, res) {
  if (!data) {
    res.status(404).json({error: 'لم يُعثر على بيانات لهذه الشركة — تحقّق من قيمة company، أو تأكد أن النظام زامَن البيانات سحابياً مرة واحدة على الأقل'});
    return true;
  }
  return false;
}

// ── نقاط النهاية (Endpoints) ──

app.get('/health', (req, res) => res.json({ok: true, time: new Date().toISOString()}));

// دليل الحسابات
app.get('/accounts', async (req, res) => {
  const data = await loadCompanyData(req.query.company);
  if (notFoundIfMissing(data, res)) return;
  const rows = (data.accounts || []).map(a => ({
    id: a.id, code: a.code, name: a.name, type: a.type, parentId: a.par,
    isLeaf: isLeaf(data.accounts, a.id), openingBalance: a.open || 0,
    cashFlowActivity: a.cfActivity || null, balanceSheetClass: a.bsClass || null,
  }));
  res.json(rows);
});

app.get('/costCenters', async (req, res) => {
  const data = await loadCompanyData(req.query.company);
  if (notFoundIfMissing(data, res)) return;
  res.json((data.costCenters || []).map(c => ({id: c.id, code: c.code || '', name: c.name, active: c.active !== false})));
});

app.get('/projects', async (req, res) => {
  const data = await loadCompanyData(req.query.company);
  if (notFoundIfMissing(data, res)) return;
  res.json((data.projects || []).map(p => ({id: p.id, code: p.code || '', name: p.name, status: p.status || null})));
});

app.get('/branches', async (req, res) => {
  const data = await loadCompanyData(req.query.company);
  if (notFoundIfMissing(data, res)) return;
  res.json((data.branches || []).map(b => ({id: b.id, name: b.name, active: b.active !== false})));
});

// القيود التفصيلية — سطر واحد لكل بند مدين/دائن (الصيغة المسطَّحة المناسبة لـPower BI)
app.get('/entries', async (req, res) => {
  const data = await loadCompanyData(req.query.company);
  if (notFoundIfMissing(data, res)) return;
  const accounts = data.accounts || [], branches = data.branches || [], costCenters = data.costCenters || [];
  const accByld = new Map(accounts.map(a => [a.id, a]));
  const ccByld = new Map(costCenters.map(c => [c.id, c]));
  const rows = [];
  postedEntries(data.entries).filter(dateFilter(req)).forEach(e => {
    const branchId = getEntryBranchId(e, branches, costCenters);
    const branch = branches.find(b => b.id === branchId);
    (e.lines || []).forEach((l, idx) => {
      const acc = accByld.get(l.accId);
      const cc = l.costCenterId ? ccByld.get(l.costCenterId) : null;
      rows.push({
        entryId: e.id, lineNo: idx + 1, date: e.date, ref: e.ref || '', description: l.desc || e.desc || '',
        accountCode: acc ? acc.code : null, accountName: acc ? acc.name : null, accountType: acc ? acc.type : null,
        debit: l.debit || 0, credit: l.credit || 0,
        costCenterName: cc ? cc.name : null, branchId: branchId, branchName: branch ? branch.name : null,
      });
    });
  });
  res.json(rows);
});

// ميزان المراجعة — رصيد افتتاحي + حركة الفترة + رصيد ختامي لكل حساب طرفي
app.get('/trialBalance', async (req, res) => {
  const data = await loadCompanyData(req.query.company);
  if (notFoundIfMissing(data, res)) return;
  const accounts = data.accounts || [];
  const from = req.query.from || '', to = req.query.to || '';
  const filtered = postedEntries(data.entries).filter(dateFilter(req));
  const byAcc = new Map();
  accounts.filter(a => isLeaf(accounts, a.id)).forEach(a => {
    let ob = parseFloat(a.open) || 0;
    if (NORM[a.type] === 'cr') ob = -ob;
    byAcc.set(a.id, {debit: 0, credit: 0, opening: from ? 0 : ob});
  });
  if (from) {
    postedEntries(data.entries).filter(e => e.date < from).forEach(e => {
      (e.lines || []).forEach(l => {
        const row = byAcc.get(l.accId);
        if (row) row.opening += (l.debit || 0) - (l.credit || 0);
      });
    });
    accounts.filter(a => isLeaf(accounts, a.id)).forEach(a => {
      let ob = parseFloat(a.open) || 0;
      if (NORM[a.type] === 'cr') ob = -ob;
      const row = byAcc.get(a.id);
      if (row) row.opening += ob;
    });
  }
  filtered.forEach(e => {
    (e.lines || []).forEach(l => {
      const row = byAcc.get(l.accId);
      if (row) { row.debit += l.debit || 0; row.credit += l.credit || 0; }
    });
  });
  const rows = accounts.filter(a => isLeaf(accounts, a.id)).map(a => {
    const row = byAcc.get(a.id);
    const closing = row.opening + row.debit - row.credit;
    return {
      accountCode: a.code, accountName: a.name, accountType: a.type,
      openingBalance: row.opening, periodDebit: row.debit, periodCredit: row.credit, closingBalance: closing,
    };
  });
  res.json(rows);
});

// ملخص حركة كل فرع — يطابق شاشة "تقرير الفروع" داخل النظام
app.get('/branchReport', async (req, res) => {
  const data = await loadCompanyData(req.query.company);
  if (notFoundIfMissing(data, res)) return;
  const branches = data.branches || [], costCenters = data.costCenters || [];
  const filtered = postedEntries(data.entries).filter(dateFilter(req));
  const rows = branches.map(b => {
    let debit = 0, credit = 0, moveCount = 0;
    filtered.forEach(e => {
      if (getEntryBranchId(e, branches, costCenters) !== b.id) return;
      (e.lines || []).forEach(l => { debit += l.debit || 0; credit += l.credit || 0; moveCount++; });
    });
    return {branchId: b.id, branchName: b.name, moveCount, totalDebit: debit, totalCredit: credit, net: debit - credit};
  });
  res.json(rows);
});

exports.powerbi = functions.https.onRequest(app);
