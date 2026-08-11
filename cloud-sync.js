// ==================================================================
// Cloud Sync — shared Firebase layer for both systems (transfers/accounting)
// Fill in firebaseConfig below with values from:
// Firebase Console → Project settings → General → Your apps → Web app
// ==================================================================
const firebaseConfig = {
  apiKey: "AIzaSyC3ZzYw_5cvFSft1TzkEUQrkkbWOmBGCLU",
  authDomain: "accounting-and-dailytsystem.firebaseapp.com",
  projectId: "accounting-and-dailytsystem",
  storageBucket: "accounting-and-dailytsystem.firebasestorage.app",
  messagingSenderId: "33110837615",
  appId: "1:33110837615:web:566ea83a3671a55e0b809a"
};

(function(){
  if(firebaseConfig.apiKey==='YOUR_API_KEY'){
    console.warn('[CloudSync] لم يتم إعداد Firebase بعد — النظام يعمل محلياً فقط (localStorage).');
    return;
  }
  if(!window.firebase){console.warn('[CloudSync] مكتبة Firebase غير محمّلة.');return;}

  firebase.initializeApp(firebaseConfig);
  const auth=firebase.auth();
  const db=firebase.firestore();

  let readyResolve;
  const ready=new Promise(res=>{readyResolve=res;});
  auth.onAuthStateChanged(user=>{if(user)readyResolve(user);});
  auth.signInAnonymously().catch(err=>console.error('[CloudSync] فشل تسجيل الدخول:',err));

  const saveTimers={};
  const lastLocalWrite={};
  const pendingData={};

  function doWrite(docName,data){
    return ready.then(()=>{
      const token=Date.now()+'_'+Math.random().toString(36).slice(2);
      lastLocalWrite[docName]=token;
      return db.collection('system').doc(docName).set({
        data:JSON.stringify(data),
        updatedAt:firebase.firestore.FieldValue.serverTimestamp(),
        writeToken:token
      });
    }).catch(err=>console.error('[CloudSync] فشل الحفظ ('+docName+'):',err));
  }

  // فترة التأخير 8 ثوانٍ (كانت 1.5) — كل تعديل متتالٍ خلال هذه المدة يُلغي مؤقت الإرسال السابق
  // ويبدأ من جديد (debounce)، فتُدمَج التعديلات السريعة المتلاحقة (كإدخال سطور قيد الواحد تلو
  // الآخر) في إرسال واحد بدل عدة إرسالات، مما يُخفِّف استهلاك حصة الكتابة اليومية المحدودة بخطة
  // Firebase المجانية (Spark) — راجع flush() للحفظ الفوري قبل إغلاق الصفحة رغم هذا التأخير
  function save(docName,data){
    pendingData[docName]=data;
    clearTimeout(saveTimers[docName]);
    saveTimers[docName]=setTimeout(()=>{
      delete saveTimers[docName];
      doWrite(docName,pendingData[docName]);
    },8000);
  }

  // كتابة فورية بدون تأخير — للعمليات الصريحة قليلة التكرار (مثال: إدارة المستخدمين)
  // حيث لا داعي للـdebounce، ويجب ألا يضيع التغيير إذا أُعيد تحميل الصفحة بسرعة
  function saveNow(docName,data){
    clearTimeout(saveTimers[docName]);
    delete saveTimers[docName];
    return doWrite(docName,data);
  }

  // إرسال أي حفظ مؤجّل (debounced) فوراً بدون انتظار — يُستخدم قبل إغلاق/تحديث الصفحة
  function flush(docName){
    if(saveTimers[docName]){
      clearTimeout(saveTimers[docName]);
      delete saveTimers[docName];
      return doWrite(docName,pendingData[docName]);
    }
    return Promise.resolve();
  }
  function flushAll(){
    return Promise.all(Object.keys(saveTimers).map(flush));
  }

  function load(docName){
    return ready.then(()=>db.collection('system').doc(docName).get()).then(snap=>{
      if(!snap.exists)return null;
      const d=snap.data();
      try{return d.data?JSON.parse(d.data):null;}catch(e){return null;}
    }).catch(err=>{console.error('[CloudSync] فشل التحميل ('+docName+'):',err);return null;});
  }

  function onChange(docName,cb){
    ready.then(()=>{
      let isFirstSnapshot=true;
      db.collection('system').doc(docName).onSnapshot(snap=>{
        // Firestore يُطلق onSnapshot فوراً عند الاشتراك بالحالة الحالية للمستند —
        // هذه ليست "تغييراً" حقيقياً، بل حالة التحميل. تجاهلها لتفادي حلقة تحديث
        // لا نهائية (كل تحميل صفحة جديد يعتبرها تغييراً خارجياً ويعيد تحميل الصفحة فوراً)
        if(isFirstSnapshot){isFirstSnapshot=false;return;}
        if(!snap.exists)return;
        const d=snap.data();
        if(!d||!d.writeToken)return;
        if(d.writeToken===lastLocalWrite[docName])return; // تجاهل التحديث الصادر من نفس الجهاز
        try{cb(JSON.parse(d.data));}catch(e){console.error(e);}
      },err=>console.error('[CloudSync] فشل الاستماع ('+docName+'):',err));
    });
  }

  function showUpdateBanner(onRefresh){
    // التحديث يطبَّق تلقائياً بدون أي إشعار أو تدخل من المستخدم
    onRefresh();
  }

  window.CloudSync={ready,save,saveNow,load,onChange,showUpdateBanner,flush,flushAll};
})();
