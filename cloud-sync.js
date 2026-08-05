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

  function save(docName,data){
    clearTimeout(saveTimers[docName]);
    saveTimers[docName]=setTimeout(()=>{
      ready.then(()=>{
        const token=Date.now()+'_'+Math.random().toString(36).slice(2);
        lastLocalWrite[docName]=token;
        db.collection('system').doc(docName).set({
          data:JSON.stringify(data),
          updatedAt:firebase.firestore.FieldValue.serverTimestamp(),
          writeToken:token
        }).catch(err=>console.error('[CloudSync] فشل الحفظ ('+docName+'):',err));
      });
    },1500);
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
      db.collection('system').doc(docName).onSnapshot(snap=>{
        if(!snap.exists)return;
        const d=snap.data();
        if(!d||!d.writeToken)return;
        if(d.writeToken===lastLocalWrite[docName])return; // تجاهل التحديث الصادر من نفس الجهاز
        try{cb(JSON.parse(d.data));}catch(e){console.error(e);}
      },err=>console.error('[CloudSync] فشل الاستماع ('+docName+'):',err));
    });
  }

  function showUpdateBanner(onRefresh){
    if(document.getElementById('cloud-sync-banner'))return;
    const bar=document.createElement('div');
    bar.id='cloud-sync-banner';
    bar.style.cssText='position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:99999;'
      +'background:#1f2937;color:#f3f4f6;border:1px solid #c8a45e;border-radius:10px;'
      +'padding:10px 16px;font-family:Tajawal,sans-serif;font-size:13.5px;display:flex;'
      +'align-items:center;gap:12px;box-shadow:0 6px 20px rgba(0,0,0,.35)';
    bar.innerHTML='<span>🔄 يوجد تحديث جديد للبيانات من جهاز آخر</span>'
      +'<button id="cloud-sync-refresh-btn" style="background:#c8a45e;color:#1a1a1a;border:0;'
      +'border-radius:6px;padding:6px 14px;font-weight:700;cursor:pointer;font-family:inherit">تحديث الآن</button>';
    document.body.appendChild(bar);
    document.getElementById('cloud-sync-refresh-btn').addEventListener('click',function(){
      bar.remove();
      onRefresh();
    });
  }

  window.CloudSync={ready,save,load,onChange,showUpdateBanner};
})();
