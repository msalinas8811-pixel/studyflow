/* Conexión con Firebase: cuentas, base de datos y la función de IA.
   Los datos de tu proyecto se leen de firebase-config.js */
import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {getAuth,onAuthStateChanged,signInWithEmailAndPassword,createUserWithEmailAndPassword,updateProfile,GoogleAuthProvider,signInWithPopup,signOut,sendPasswordResetEmail,sendEmailVerification,EmailAuthProvider,reauthenticateWithCredential,updatePassword} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {getFirestore,doc,collection,getDoc,getDocs,setDoc,updateDoc,deleteDoc,addDoc,onSnapshot,query,where} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {getFunctions,httpsCallable} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

const cfg=window.FIREBASE_CONFIG||{};
function ready(api){window.FBAPI=api;window.dispatchEvent(new Event('fb-ready'))}

if(!cfg.apiKey||/PEGA|TU_/.test(cfg.apiKey)){
  ready({configured:false});
}else{
  const app=initializeApp(cfg);
  const auth=getAuth(app),fs=getFirestore(app),fn=getFunctions(app,cfg.functionsRegion||'us-central1');
  const callAI=httpsCallable(fn,'ai',{timeout:130000});
  const callAdmin=httpsCallable(fn,'admin',{timeout:60000});
  const callSchool=httpsCallable(fn,'school',{timeout:60000});
  const ADMIN_EMAILS=['msalinas8811@gmail.com'];

  const wrapDoc=d=>({id:d.id,exists:d.exists(),data:()=>d.data(),metadata:d.metadata});
  const dbErr=e=>({code:e&&e.code==='permission-denied'?'permission-denied':e&&e.code==='resource-exhausted'?'quota_exceeded':e&&e.code==='invalid-argument'?'invalid_argument':'unavailable',message:String(e&&e.message||e)});

  /* Misma interfaz pequeña que usa la app, limitada a la familia */
  function scoped(fid){
    const map=p=>p==='family/config'?`families/${fid}/meta/config`:p==='family/plan'?`families/${fid}/meta/plan`:`families/${fid}/${p}`;
    const dref=path=>{const r=doc(fs,map(path));return{id:r.id,path,
      get:async()=>wrapDoc(await getDoc(r)),set:d=>setDoc(r,d).catch(e=>{throw dbErr(e)}),update:d=>updateDoc(r,d).catch(e=>{throw dbErr(e)}),
      delete:()=>deleteDoc(r).catch(e=>{throw dbErr(e)}),onSnapshot:(n,e)=>onSnapshot(r,s=>n(wrapDoc(s)),err=>e&&e(dbErr(err)))}};
    const cref=path=>{const c=collection(fs,map(path));return{path,
      doc:id=>dref(path+'/'+(id||doc(c).id)),
      add:async d=>{try{const r=await addDoc(c,d);return dref(path+'/'+r.id)}catch(e){throw dbErr(e)}},
      onSnapshot:(n,e)=>onSnapshot(c,s=>n({docs:s.docs.map(wrapDoc),size:s.size,empty:s.empty}),err=>e&&e(dbErr(err)))}};
    return{doc:dref,collection:cref};
  }

  /* Acceso fuera de la familia (grupos de estudio, perfil propio): lo limitan las reglas de Firestore */
  function rootDoc(path){const r=doc(fs,path);return{id:r.id,path,get:async()=>{try{return wrapDoc(await getDoc(r))}catch(e){throw dbErr(e)}},
    set:d=>setDoc(r,d).catch(e=>{throw dbErr(e)}),update:d=>updateDoc(r,d).catch(e=>{throw dbErr(e)}),delete:()=>deleteDoc(r).catch(e=>{throw dbErr(e)}),
    onSnapshot:(n,e)=>onSnapshot(r,s=>n(wrapDoc(s)),err=>e&&e(dbErr(err)))}}
  function rootCollection(path){const c=collection(fs,path);return{path,doc:id=>rootDoc(path+'/'+(id||doc(c).id)),
    add:async d=>{try{const r=await addDoc(c,d);return rootDoc(path+'/'+r.id)}catch(e){throw dbErr(e)}},
    get:async()=>{try{const s=await getDocs(c);return{docs:s.docs.map(wrapDoc),size:s.size,empty:s.empty}}catch(e){throw dbErr(e)}},
    onSnapshot:(n,e)=>onSnapshot(c,s=>n({docs:s.docs.map(wrapDoc),size:s.size,empty:s.empty,fromCache:s.metadata.fromCache}),err=>e&&e(dbErr(err)))}}
  const root={doc:rootDoc,collection:rootCollection};

  const CH='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const newCode=()=>Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b=>CH[b%CH.length]).join('');

  async function createFamily(name,person,rel){
    const uid=auth.currentUser.uid,fid=doc(collection(fs,'families')).id;
    let code=newCode();
    for(let i=0;i<5;i++){const c=await getDoc(doc(fs,'codes',code));if(!c.exists())break;code=newCode()}
    await setDoc(doc(fs,'families',fid),{name,owner:uid,code,createdAt:Date.now()});
    await setDoc(doc(fs,'families',fid,'members',uid),{role:'parent',name:person,rel:rel||'',joinedAt:Date.now()});
    await setDoc(doc(fs,'codes',code),{familyId:fid,owner:uid});
    const prof={familyId:fid,role:'parent',name:person,rel:rel||''};
    await setDoc(doc(fs,'users',uid),prof);
    return prof;
  }
  async function joinFamily(code,role,person,grade,rel){
    const uid=auth.currentUser.uid,c=await getDoc(doc(fs,'codes',code));
    if(!c.exists())throw{code:'code'};
    const fid=c.data().familyId;
    await setDoc(doc(fs,'families',fid,'members',uid),{role,name:person,code,rel:role==='parent'?(rel||''):'',joinedAt:Date.now()});
    const prof={familyId:fid,role,name:person,grade:grade||''};if(role==='parent')prof.rel=rel||'';
    await setDoc(doc(fs,'users',uid),prof);
    return prof;
  }

  /* IA: se llama a la función "ai" de tu proyecto (la llave nunca está en la app) */
  async function shrink(file){
    try{
      const bmp=await createImageBitmap(file),max=1568,k=Math.min(1,max/Math.max(bmp.width,bmp.height));
      const cv=document.createElement('canvas');cv.width=Math.round(bmp.width*k);cv.height=Math.round(bmp.height*k);
      cv.getContext('2d').drawImage(bmp,0,0,cv.width,cv.height);
      const url=cv.toDataURL('image/jpeg',0.85);
      return{media_type:'image/jpeg',data:url.split(',')[1]};
    }catch(e){throw{code:'image_rejected',message:'No se pudo leer la imagen'}}
  }
  const aiErr=e=>{
    const c=e&&e.code||'',m=String(e&&e.message||'');
    if(c.includes('resource-exhausted'))return{code:m==='limit'?'limit_reached':'rate_limited',message:m};
    if(c.includes('permission-denied'))return{code:m==='pro_required'?'pro_required':'not_granted',message:m};
    if(c.includes('unauthenticated'))return{code:'session_expired',message:m};
    if(c.includes('invalid-argument'))return{code:'invalid_request',message:m};
    return{code:'upstream_error',message:m};
  };
  function sampler(){
    const f=async(input,opts={})=>{
      const messages=typeof input==='string'?[{role:'user',content:input}]:input.map(m=>({role:m.role,content:m.content}));
      let image=null;
      if(opts.images){const list=opts.images.length!=null?opts.images:[opts.images];if(list[0])image=await shrink(list[0])}
      if(opts.signal&&opts.signal.aborted)throw{code:'cancelled'};
      const call=callAI({kind:opts.kind||'other',messages,image}).then(r=>r.data,e=>{throw aiErr(e)});
      const stop=new Promise((_,rej)=>{if(opts.signal)opts.signal.addEventListener('abort',()=>rej({code:'cancelled'}),{once:true})});
      const r=await Promise.race([call,stop]);
      const text=String(r.text||'');
      if(!text.trim())throw{code:'empty_completion'};
      if(opts.onText)opts.onText({text,delta:text});
      return{text,truncated:!!r.truncated};
    };
    f.json=async(input,opts={})=>{
      const r=await f(input,Object.assign({},opts,{onText:null}));
      const t=r.text;
      const tryParse=s=>{try{return{ok:true,v:JSON.parse(s)}}catch(e){return{ok:false}}};
      let p=tryParse(t.trim());
      if(!p.ok){const m=t.match(/```(?:json)?\s*([\s\S]*?)```/);if(m)p=tryParse(m[1].trim())}
      if(!p.ok){const a=t.search(/[\[{]/),b=Math.max(t.lastIndexOf(']'),t.lastIndexOf('}'));if(a>-1&&b>a)p=tryParse(t.slice(a,b+1))}
      if(!p.ok)throw{code:'invalid_json',text:t};
      return p.v;
    };
    f.limits=async()=>({maxPromptBytes:200000,images:{maxCount:1,maxInputBytes:20e6,mediaTypes:['image/jpeg','image/png','image/webp']}});
    return f;
  }

  ready({
    configured:true,
    onAuth:cb=>onAuthStateChanged(auth,cb),
    signIn:(e,p)=>signInWithEmailAndPassword(auth,e,p),
    signUp:async(e,p,name)=>{const c=await createUserWithEmailAndPassword(auth,e,p);try{await updateProfile(c.user,{displayName:name})}catch(_){}
      await setDoc(doc(fs,'users',c.user.uid),{name},{merge:true})},
    google:()=>signInWithPopup(auth,new GoogleAuthProvider()),
    reset:e=>sendPasswordResetEmail(auth,e),
    signOut:()=>signOut(auth),
    profile:async uid=>{const d=await getDoc(doc(fs,'users',uid));return d.exists()?d.data():null},
    family:async fid=>{const d=await getDoc(doc(fs,'families',fid));return d.exists()?d.data():null},
    createFamily,joinFamily,
    db:scoped,root,
    sampler:sampler(),
    email:()=>auth.currentUser&&auth.currentUser.email,
    isAdminEmail:()=>!!(auth.currentUser&&ADMIN_EMAILS.includes(String(auth.currentUser.email||'').toLowerCase())),
    admin:async(action,data)=>{
      if(auth.currentUser)await auth.currentUser.getIdToken(true);
      try{return (await callAdmin(Object.assign({action},data||{}))).data}catch(e){throw{code:String(e&&e.message||'error')}}
    },
    temLink:async(action,d)=>{try{return (await httpsCallable(fn,'temLink',{timeout:30000})(Object.assign({action},d||{}))).data}catch(e){throw{code:String(e&&e.message||'error')}}},
    teacherReq:async d=>(await httpsCallable(fn,'teacherReq',{timeout:30000})(d)).data,
    teacherGet:async token=>(await httpsCallable(fn,'teacherGet',{timeout:20000})({token})).data,
    teacherAnswer:async (token,result,comment)=>(await httpsCallable(fn,'teacherAnswer',{timeout:20000})({token,result,comment})).data,
    school:async(action,data)=>{
      if(auth.currentUser)await auth.currentUser.getIdToken(/^invite/.test(action));
      try{return (await callSchool(Object.assign({action},data||{}))).data}catch(e){throw{code:String(e&&e.message||'error')}}
    },
    sendVerify:()=>sendEmailVerification(auth.currentUser),
    hasPassword:()=>!!(auth.currentUser&&auth.currentUser.providerData.some(p=>p.providerId==='password')),
    changePassword:async(cur,np)=>{const u=auth.currentUser;await reauthenticateWithCredential(u,EmailAuthProvider.credential(u.email,cur));await updatePassword(u,np)},
    reloadUser:()=>auth.currentUser.reload(),
    billing:async()=>{try{const d=await getDoc(doc(fs,'public','billing'));return d.exists()?d.data():{}}catch(e){return {}}},
    payReq:async(fid,o)=>{const uid=auth.currentUser.uid;
      await addDoc(collection(fs,'payReqs'),{uid,familyId:fid,status:'pending',cycle:o.cycle,method:o.method,ref:o.ref,name:o.name,at:Date.now()})},
    myPayReqs:async()=>{const uid=auth.currentUser.uid;
      try{const q=await getDocs(query(collection(fs,'payReqs'),where('uid','==',uid)));return q.docs.map(d=>Object.assign({id:d.id},d.data()))}catch(e){return []}}
  });
}
