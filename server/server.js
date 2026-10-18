require('dotenv').config();
const express=require('express'),crypto=require('crypto'),path=require('path');
const {Pool}=require('pg');
const CAT=require('./catalog'),E=process.env,app=express();

// --- PostgreSQL bağlantı havuzu (Neon) ---
const pool=new Pool({
  connectionString:E.DATABASE_URL,
  ssl:{rejectUnauthorized:false}
});

// --- Tabloları ilk çalıştırmada oluştur ---
async function initDb(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      coin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      oid TEXT PRIMARY KEY,
      user_key TEXT NOT NULL,
      coin INTEGER NOT NULL,
      tl NUMERIC NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      item TEXT NOT NULL,
      label TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      at BIGINT NOT NULL
    );
  `);
}
initDb().catch(e=>console.error('DB init hatası:',e));

const sess=new Map(),NAME=/^[A-Za-z0-9_]{3,16}$/;
const ITEMS=Object.fromEntries([...CAT.rank,...CAT.key,...CAT.set].map(i=>[i.id,i]));
const PACKS=Object.fromEntries(CAT.coin.map(i=>[i.id,i]));
app.set('trust proxy',1);app.use(express.json());app.use(express.urlencoded({extended:false}));
const sid=r=>Object.fromEntries((r.headers.cookie||'').split(';').filter(Boolean).map(c=>c.trim().split('=')))['sid'];
const pub=u=>({name:u.name,coin:u.coin});
const hash=(p,s)=>crypto.scryptSync(p,s,64).toString('hex');
function start(res,k){const t=crypto.randomBytes(24).toString('hex');sess.set(t,k);
  res.setHeader('Set-Cookie',`sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${E.NODE_ENV==='production'?'; Secure':''}`)}

// --- ACME http-01 doğrulama dosyaları ---
app.use('/.well-known/acme-challenge',express.static(path.join(__dirname,'.well-known','acme-challenge'),{dotfiles:'allow'}));

// --- Oturum doğrulama ---
const auth=async(req,res,next)=>{
  const k=sess.get(sid(req));
  if(!k)return res.status(401).json({error:'Önce giriş yapmalısın.'});
  try{
    const r=await pool.query('SELECT * FROM users WHERE key=$1',[k]);
    if(!r.rows[0])return res.status(401).json({error:'Önce giriş yapmalısın.'});
    req.k=k;req.u=r.rows[0];next();
  }catch(e){res.status(500).json({error:'Veritabanı hatası.'})}
};

app.get('/api/catalog',(q,r)=>r.json(CAT));

app.post('/api/register',async(req,res)=>{
  const {name,email,password}=req.body||{};
  if(!NAME.test(name||''))return res.status(400).json({error:'Kullanıcı adı 3-16 karakter olmalı (harf, rakam, _).'});
  if(!/^\S+@\S+\.\S+$/.test(email||''))return res.status(400).json({error:'Geçerli bir e-posta gir.'});
  if((password||'').length<6)return res.status(400).json({error:'Şifre en az 6 karakter olmalı.'});
  const k=name.toLowerCase();
  try{
    const ex=await pool.query('SELECT 1 FROM users WHERE key=$1',[k]);
    if(ex.rows[0])return res.status(409).json({error:'Bu kullanıcı adı alınmış.'});
    const salt=crypto.randomBytes(16).toString('hex');
    const h=hash(password,salt);
    const r=await pool.query(
      'INSERT INTO users (key,name,email,salt,hash,coin) VALUES ($1,$2,$3,$4,$5,0) RETURNING name,coin',
      [k,name,email,salt,h]
    );
    start(res,k);res.json(pub(r.rows[0]));
  }catch(e){res.status(500).json({error:'Veritabanı hatası.'})}
});

app.post('/api/login',async(req,res)=>{
  const {name,password}=req.body||{},k=String(name||'').toLowerCase();
  try{
    const r=await pool.query('SELECT * FROM users WHERE key=$1',[k]);
    const u=r.rows[0];
    if(!u||!crypto.timingSafeEqual(Buffer.from(hash(String(password||''),u.salt),'hex'),Buffer.from(u.hash,'hex')))
      return res.status(401).json({error:'Kullanıcı adı veya şifre hatalı.'});
    start(res,k);res.json(pub(u));
  }catch(e){res.status(500).json({error:'Veritabanı hatası.'})}
});

app.post('/api/logout',(req,res)=>{sess.delete(sid(req));res.setHeader('Set-Cookie','sid=; Max-Age=0; Path=/');res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>res.json(pub(req.u)));

app.post('/api/buy',auth,async(req,res)=>{
  const it=ITEMS[(req.body||{}).id];
  if(!it)return res.status(400).json({error:'Ürün bulunamadı.'});
  if(req.u.coin<it.p)return res.status(400).json({error:'Yetersiz coin.'});
  try{
    await pool.query('UPDATE users SET coin=coin-$1 WHERE key=$2',[it.p,req.k]);
    await pool.query(
      'INSERT INTO deliveries (id,user_name,item,label,done,at) VALUES ($1,$2,$3,$4,FALSE,$5)',
      [crypto.randomUUID(),req.u.name,it.id,it.n,Date.now()]
    );
    const r=await pool.query('SELECT name,coin FROM users WHERE key=$1',[req.k]);
    res.json(pub(r.rows[0]));
  }catch(e){res.status(500).json({error:'Veritabanı hatası.'})}
});

app.get('/api/deliveries',async(req,res)=>{
  if(!E.PLUGIN_KEY||req.headers['x-plugin-key']!==E.PLUGIN_KEY)return res.status(403).json({error:'yetkisiz'});
  try{
    const r=await pool.query('SELECT id,user_name AS user,item,label FROM deliveries WHERE done=FALSE');
    if(r.rows.length)await pool.query('UPDATE deliveries SET done=TRUE WHERE id=ANY($1)',[r.rows.map(x=>x.id)]);
    res.json(r.rows);
  }catch(e){res.status(500).json({error:'Veritabanı hatası.'})}
});

app.post('/api/pay/create',auth,async(req,res)=>{
  const pack=PACKS[(req.body||{}).id||(req.body||{}).packId];
  if(!pack)return res.status(400).json({error:'Paket bulunamadı.'});
  if(!E.PAYTR_MERCHANT_ID)return res.status(503).json({error:'Ödeme sistemi henüz yapılandırılmadı.'});
  const {fullName,phone}=req.body,oid='WMC'+Date.now()+crypto.randomBytes(3).toString('hex');
  const ip=(req.ip||'').replace('::ffff:',''),amount=String(pack.tl*100),test=E.PAYTR_TEST_MODE||'1';
  const basket=Buffer.from(JSON.stringify([[pack.n,pack.tl.toFixed(2),1]])).toString('base64');
  const sig=E.PAYTR_MERCHANT_ID+ip+oid+req.u.email+amount+basket+'0'+'0'+'TL'+test;
  const token=crypto.createHmac('sha256',E.PAYTR_MERCHANT_KEY).update(sig+E.PAYTR_MERCHANT_SALT).digest('base64');
  const body=new URLSearchParams({merchant_id:E.PAYTR_MERCHANT_ID,user_ip:ip,merchant_oid:oid,email:req.u.email,payment_amount:amount,
    paytr_token:token,user_basket:basket,debug_on:'1',no_installment:'0',max_installment:'0',user_name:String(fullName||req.u.name),
    user_address:'Dijital ürün',user_phone:String(phone||''),merchant_ok_url:E.SITE_URL+'/magaza.html?odeme=ok',
    merchant_fail_url:E.SITE_URL+'/magaza.html?odeme=fail',timeout_limit:'30',currency:'TL',test_mode:test});
  try{
    const r=await fetch('https://www.paytr.com/odeme/api/get-token',{method:'POST',body});
    const j=await r.json();
    if(j.status!=='success')return res.status(502).json({error:'Ödeme başlatılamadı: '+(j.reason||'bilinmeyen hata')});
    await pool.query('INSERT INTO orders (oid,user_key,coin,tl,status) VALUES ($1,$2,$3,$4,$5)',
      [oid,req.k,pack.coin,pack.tl,'pending']);
    res.json({token:j.token});
  }catch(e){res.status(502).json({error:'Ödeme sağlayıcısına ulaşılamadı.'})}
});

app.post('/api/pay/callback',async(req,res)=>{
  const {merchant_oid:oid,status,total_amount:total,hash:h}=req.body||{};
  const calc=crypto.createHmac('sha256',E.PAYTR_MERCHANT_KEY||'').update(String(oid)+(E.PAYTR_MERCHANT_SALT||'')+status+total).digest('base64');
  if(calc!==h)return res.status(400).send('PAYTR notification failed: bad hash');
  try{
    const r=await pool.query('SELECT * FROM orders WHERE oid=$1',[oid]);
    const o=r.rows[0];
    if(o&&o.status==='pending'){
      if(status==='success'){
        await pool.query('UPDATE users SET coin=coin+$1 WHERE key=$2',[o.coin,o.user_key]);
        await pool.query('UPDATE orders SET status=$1 WHERE oid=$2',['paid',oid]);
      }else{
        await pool.query('UPDATE orders SET status=$1 WHERE oid=$2',['failed',oid]);
      }
    }
    res.send('OK');
  }catch(e){res.status(500).send('DB error')}
});

// --- Statik dosyalar: site klasörü server'ın bir üst dizininde ---
const SITE_DIR = path.resolve(__dirname, '..', 'site');
app.use(express.static(SITE_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(SITE_DIR, 'index.html'), (err) => {
    if (err) {
      console.error('index.html okunamadı:', err.message);
      console.error('Aranan yol:', path.join(SITE_DIR, 'index.html'));
      res.status(404).send('index.html bulunamadı. site klasörü server ile aynı üst dizinde mi?');
    }
  });
});

app.listen(E.PORT||3000,()=>console.log('WardenMC: http://localhost:'+(E.PORT||3000)));