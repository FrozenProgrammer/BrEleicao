// Backend local opcional para o protótipo Brazil Eleições 2026.
// Node 18+ (Node 20/22 recomendado), sem dependências externas.
//
// O backend:
// 1) lê o EA12 oficial para obter municípios + zonas;
// 2) baixa uma única vez o arquivo oficial TSE "Eleitorado por local de votação - 2026";
// 3) transforma NM_BAIRRO + CD_MUNICIPIO + NR_ZONA em um índice compacto;
// 4) mantém índices auxiliares de bairros/seções para uso do aplicativo;
// 5) opcionalmente faz proxy/cache de resultados TSE em /api/result.
//
// Importante: Bairro é o bairro cadastrado para o LOCAL DE VOTAÇÃO no TSE.
// Se um bairro tiver locais em várias zonas, o frontend agrega essas zonas.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {StringDecoder} = require('string_decoder');
const crypto = require('crypto');

const APP_VERSION = '2.9.0';
const NODE_ENV = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const PORT = Number(process.env.PORT || 8000);
const HOST = String(process.env.HOST || '127.0.0.1').trim();
if(!Number.isInteger(PORT) || PORT<1 || PORT>65535) throw new Error('PORT inválida.');
if(!HOST) throw new Error('HOST inválido.');
const ROOT = __dirname;
const CACHE_DIR = process.env.BR_ELEICOES_CACHE_DIR ? path.resolve(process.env.BR_ELEICOES_CACHE_DIR) : path.join(ROOT, '.cache-brazil-eleicoes-2026');
const MUNICIPIOS_URL = 'https://resultados.tse.jus.br/oficial/ele2026/6259/config/mun-e006259-cm.json';
const LOCAIS_URL = 'https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip';
const TSE_BASE = 'https://resultados.tse.jus.br/oficial/ele2026';
const GEO_FILE = path.join(CACHE_DIR, 'neighborhoods-v3.json');
const MUN_FILE = path.join(CACHE_DIR, 'municipios-v2.json');
const ZIP_FILE = path.join(CACHE_DIR, 'eleitorado_local_votacao_2026.zip');
const RESULT_DIR = path.join(CACHE_DIR, 'results-v29');
const CANDIDATOS_URL = 'https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_2026.zip';
const CANDIDATOS_FILE = path.join(CACHE_DIR, 'consulta_cand_2026.zip');
const CANDIDATOS_INDEX = path.join(CACHE_DIR, 'candidates-v1.json');
const SECTION_DIR = path.join(CACHE_DIR, 'sections');
const BU_DIR = path.join(CACHE_DIR, 'bu');
const BU_BASE_URL = 'https://cdn.tse.jus.br/estatistica/sead/eleicoes/eleicoes2026/buweb/bweb_1t_';
const BU_STAMP = '_051020261403.zip';
const MAX_RESULT_CACHE_FILES = Number(process.env.BR_ELEICOES_MAX_RESULT_CACHE_FILES || 10000);
const MAX_RESULT_CACHE_BYTES = Number(process.env.BR_ELEICOES_MAX_RESULT_CACHE_BYTES || 2 * 1024 * 1024 * 1024);
const CACHE_CLEANUP_INTERVAL_MS = Number(process.env.BR_ELEICOES_CACHE_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = Number(process.env.BR_ELEICOES_RATE_LIMIT || 120);
const EXPENSIVE_RATE_LIMIT = Number(process.env.BR_ELEICOES_EXPENSIVE_RATE_LIMIT || 12);
const EXPENSIVE_CONCURRENCY = Number(process.env.BR_ELEICOES_EXPENSIVE_CONCURRENCY || 1);
const rateBuckets = new Map();
const expensiveRateBuckets = new Map();
const inFlightResults = new Map();
const downloadPromises = new Map();
let expensiveActive = 0;
const expensiveQueue = [];
fs.mkdirSync(SECTION_DIR, {recursive:true});
fs.mkdirSync(BU_DIR, {recursive:true});

function ensureLocaisZip(){
  if(fs.existsSync(ZIP_FILE)) return Promise.resolve();
  if(downloadPromises.has('locais')) return downloadPromises.get('locais');
  const p=download(LOCAIS_URL, ZIP_FILE).finally(()=>downloadPromises.delete('locais'));
  downloadPromises.set('locais',p);
  return p;
}
function zipEntriesForUfServer(entries,uf){
  const up=String(uf||'').toUpperCase();
  const matches=entries.filter(e=>String(e.name).toUpperCase().includes(up));
  return matches.length ? matches : (entries.length===1 ? entries : []);
}
const SECTION_BUILD_PROMISES=new Map();
async function buildSectionsForMunicipio(uf,municipio){
  const key=String(uf).toUpperCase()+'|'+String(municipio).padStart(5,'0');
  const file=path.join(SECTION_DIR,'index_'+key.replace('|','_')+'.json');
  if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8'));
  if(SECTION_BUILD_PROMISES.has(key))return SECTION_BUILD_PROMISES.get(key);
  const p=(async()=>{
    await ensureLocaisZip();
    const entries=zipEntriesForUfServer(zipEntriesFromFile(ZIP_FILE).filter(e=>/\.csv$/i.test(e.name)),uf);
    if(!entries.length)throw new Error('Nenhum CSV de locais de votação encontrado para '+uf+'.');
    const map=new Map();
    for(const e of entries){
      await processZipEntryStream(ZIP_FILE,e,row=>{
        const ruf=String(row.SG_UF||'').trim().toUpperCase();
        const code=String(row.CD_MUNICIPIO||'').trim().padStart(5,'0');
        if(ruf!==String(uf).toUpperCase()||code!==String(municipio).padStart(5,'0'))return;
        const zone=Number(row.NR_ZONA),section=Number(row.NR_SECAO);
        if(!Number.isFinite(zone)||!Number.isFinite(section))return;
        const k=zone+'|'+section;if(!map.has(k))map.set(k,{section,zone});
      });
    }
    const out=[...map.values()].sort((a,b)=>a.section-b.section||a.zone-b.zone);
    writeJsonAtomic(file,out);return out;
  })();
  SECTION_BUILD_PROMISES.set(key,p);p.finally(()=>SECTION_BUILD_PROMISES.delete(key));return p;
}
const BU_PROMISES=new Map();
async function ensureBuZip(uf){
  const up=String(uf||'').toUpperCase(),file=path.join(BU_DIR,'bweb_1t_'+up+'.zip');
  if(fs.existsSync(file))return file;if(BU_PROMISES.has(up))return BU_PROMISES.get(up);
  const p=download(BU_BASE_URL+up+BU_STAMP,file).then(()=>file).finally(()=>BU_PROMISES.delete(up));
  BU_PROMISES.set(up,p);return p;
}
function extractCandidateMetadata(raw,cargoCode){
  const cargo=(raw?.carg||[]).find(c=>String(c.cd).padStart(4,'0')===cargoCode)||(raw?.carg||[])[0],map=new Map();
  for(const agr of (cargo?.agr||[]))for(const par of (agr.par||[]))for(const cand of (par.cand||[])){
    const numero=String(cand.n??'');if(!numero)continue;const status=String(cand.dvt||'').trim();
    map.set(numero,{nome:cand.nmu||cand.nm||'',partido:par.sg||'',numero,status,valid:status===''||/^válido(?:\s|$)/i.test(status)});
  }return map;
}
async function sectionResultUnbounded(rawQuery){
  const q=validateSectionQuery(rawQuery),uf=q.uf.toUpperCase(),municipio=q.municipio,zone=q.zona,section=q.secao;
  const buFile=await ensureBuZip(uf),entries=zipEntriesForUfServer(zipEntriesFromFile(buFile).filter(e=>/\.csv$/i.test(e.name)),uf);
  if(!entries.length)throw new Error('Nenhum arquivo de boletim de urna encontrado para '+uf+'.');
  const totals=new Map();
  const sectionRows=[];
  for(const e of entries)await processZipEntryStream(buFile,e,row=>{
    if(String(row.ANO_ELEICAO||'')!=='2026'||String(row.NR_TURNO||'')!=='1')return;
    if(String(row.SG_UF||'').trim().toUpperCase()!==uf||String(row.CD_MUNICIPIO||'').trim().padStart(5,'0')!==municipio)return;
    if(Number(row.NR_ZONA)!==zone||Number(row.NR_SECAO)!==section)return;
    if(String(row.CD_CARGO||'').trim().padStart(4,'0')!==q.cargo)return;
    const n=String(row.NR_CANDIDATO||'').trim();if(!n)return;
    const tipo=String(row.TP_VOTO??'').trim().toLowerCase();
    const votos=Number(String(row.QT_VOTOS??row.QT_VOTOS_NOMINAIS??row.QT_VOTO??'0').replace(',','.'))||0;
    sectionRows.push({n,tipo,votos,row});
  });
  // The 2026 BU files use TP_VOTO=nominal, but keep the parser tolerant to
  // equivalent encodings used by TSE exports. This prevents a valid section
  // from silently becoming 0 when the export changes only the vote-type code.
  const nominal=sectionRows.filter(x=>['nominal','n','1','candidato','candidate'].includes(x.tipo));
  const chosen=nominal.length?nominal:sectionRows.filter(x=>!['legenda','l','2','branco','b','3','nulo','4'].includes(x.tipo));
  for(const x of chosen)totals.set(x.n,(totals.get(x.n)||0)+x.votos);
  const zoneRaw=JSON.parse(await getText(resultUrl({election:q.election,cargo:q.cargo,uf:q.uf.toLowerCase(),municipio,zona:String(zone)})));
  const metadata=extractCandidateMetadata(zoneRaw,q.cargo);
  const rows=[...totals.entries()].map(([numero,votos])=>{const m=metadata.get(numero)||{nome:'Candidato '+numero,partido:'',numero,status:'',valid:true};return {...m,votos};}).filter(x=>x.valid).sort((a,b)=>b.votos-a.votos||a.nome.localeCompare(b.nome,'pt-BR'));
  const validos=rows.reduce((a,x)=>a+x.votos,0);rows.forEach(x=>x.percentual=validos?x.votos/validos*100:0);
  // Never persist a silent empty result: an empty section is almost always a
  // parsing/schema mismatch and must be retried after the parser is updated.
  if(!rows.length&&sectionRows.length) console.warn(`Seção ${uf}/${municipio}/${zone}/${section}: ${sectionRows.length} registros de candidato encontrados, mas nenhum candidato válido foi associado.`);
  return {rows,validos,comparecimento:Number(sectionRows.find(x=>x.row.QT_COMPARECIMENTO)?.row.QT_COMPARECIMENTO||0),secoes:1,secoesTotal:1,final:true,section,zone};
}


function withExpensiveSlot(fn){
  return new Promise((resolve,reject)=>{
    const run=()=>{
      expensiveActive++;
      Promise.resolve().then(fn).then(resolve,reject).finally(()=>{
        expensiveActive--;
        const next=expensiveQueue.shift();
        if(next)next();
      });
    };
    if(expensiveActive<EXPENSIVE_CONCURRENCY)run();else expensiveQueue.push(run);
  });
}

function sectionResult(rawQuery){
  return withExpensiveSlot(()=>sectionResultUnbounded(rawQuery));
}


fs.mkdirSync(CACHE_DIR, {recursive:true});
fs.mkdirSync(RESULT_DIR, {recursive:true});

function writeJsonAtomic(file,obj){
 const tmp=`${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
 fs.writeFileSync(tmp,JSON.stringify(obj));
 fs.renameSync(tmp,file);
}
function download(url, target, redirectDepth=0) {
  if(redirectDepth>3)return Promise.reject(new Error('Redirecionamentos demais.'));
  return new Promise((resolve,reject)=>{
    const tmp=`${target}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const cleanup=()=>{try{fs.unlinkSync(tmp)}catch{}};
    const file=fs.createWriteStream(tmp);
    const req=https.get(url,{headers:{'User-Agent':'Brazil-Eleicoes-2026-local/1.0'},timeout:20_000},res=>{
      if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
        const next=new URL(res.headers.location,url);
        const allowedHosts=new Set(['cdn.tse.jus.br','resultados.tse.jus.br']);
        res.resume();
        if(!allowedHosts.has(next.hostname)){file.close();cleanup();reject(new Error('Redirecionamento externo não permitido.'));return;}
        file.close();cleanup();
        return download(next.href,target,redirectDepth+1).then(resolve,reject);
      }
      if(res.statusCode !== 200){res.resume();file.close();cleanup();reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`));return;}
      const maxBytes=Number(process.env.BR_ELEICOES_MAX_DOWNLOAD_BYTES || 1024*1024*1024);
      const declared=Number(res.headers['content-length']||0);
      if(declared>maxBytes){res.resume();file.close();cleanup();reject(new Error('Download TSE excede o limite permitido.'));return;}
      let received=0;
      res.on('data',chunk=>{received+=chunk.length;if(received>maxBytes){res.destroy(new Error('Download TSE excede o limite permitido.'));}});
      res.on('error',err=>{file.destroy();cleanup();reject(err);});
      res.pipe(file);
      file.on('finish',()=>file.close(()=>{try{fs.renameSync(tmp,target);resolve();}catch(e){cleanup();reject(e);}}));
    });
    req.on('timeout',()=>req.destroy(new Error(`Timeout ao baixar ${url}`)));
    req.on('error',e=>{file.close();cleanup();reject(e)});
    file.on('error',e=>{req.destroy();cleanup();reject(e)});
  });
}
function getText(url){
 return new Promise((resolve,reject)=>{
  const req=https.get(url,{headers:{'User-Agent':'Brazil-Eleicoes-2026-local/1.0'},timeout:15_000},res=>{
   if(res.statusCode!==200){res.resume();reject(new Error(`HTTP ${res.statusCode}`));return;}
   const chunks=[];let size=0;const max=20*1024*1024;
   res.on('data',c=>{size+=c.length;if(size>max){res.destroy(new Error('Resposta TSE excedeu o limite permitido.'));return;}chunks.push(c);});
   res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
   res.on('error',reject);
  });
  req.on('timeout',()=>req.destroy(new Error(`Timeout ao consultar ${url}`)));
  req.on('error',reject);
 });
}
function parseCsvLine(line, sep=';'){
 const out=[];let cur='';let q=false;
 for(let i=0;i<line.length;i++){
  const c=line[i];
  if(c==='"'){
   if(q && line[i+1]==='"'){cur+='"';i++;}
   else q=!q;
  } else if(c===sep && !q){out.push(cur);cur='';}
  else cur+=c;
 }
 out.push(cur);return out;
}
function csvRows(text){
 // Handles quoted multiline fields sufficiently for this dataset by assembling
 // physical lines until quote balance closes.
 const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
 if(!lines.length)return [];
 const header=parseCsvLine(lines[0]).map(x=>x.trim());
 const rows=[];let buf='';let quoted=false;
 for(let i=1;i<lines.length;i++){
  const line=lines[i];
  buf += (buf?'\n':'')+line;
  let n=0; for(let j=0;j<buf.length;j++) if(buf[j]==='"' && buf[j-1]!=='"') n++;
  quoted=(n%2)!==0;
  if(quoted) continue;
  if(!buf.trim())continue;
  const vals=parseCsvLine(buf);const row={};
  header.forEach((h,k)=>row[h]=vals[k]??'');rows.push(row);buf='';
 }
 return rows;
}

// Minimal ZIP reader that never loads the whole national ZIP into RAM.
// The previous implementation read the complete ZIP and then decompressed every
// CSV at once, which could push Node beyond a 4 GB heap. Here we read only the
// ZIP central directory plus one compressed CSV entry at a time.
function zipEntriesFromFile(file){
 const stat=fs.statSync(file);
 const tailSize=Math.min(stat.size, 65557);
 const tail=Buffer.alloc(tailSize);
 const fd=fs.openSync(file,'r');
 try{fs.readSync(fd,tail,0,tail.length,stat.size-tail.length);}finally{fs.closeSync(fd);}
 let eocd=-1;
 for(let i=tail.length-22;i>=0;i--){if(tail.readUInt32LE(i)===0x06054b50){eocd=i;break;}}
 if(eocd<0)throw new Error('ZIP EOCD não encontrado');
 const count=tail.readUInt16LE(eocd+10), cdSize=tail.readUInt32LE(eocd+12), cdOffset=tail.readUInt32LE(eocd+16);
 if(cdOffset+cdSize>stat.size)throw new Error('Diretório central ZIP inválido');
 const cd=Buffer.alloc(cdSize), fd2=fs.openSync(file,'r');
 try{fs.readSync(fd2,cd,0,cd.length,cdOffset);}finally{fs.closeSync(fd2);}
 const entries=[];let p=0;
 for(let i=0;i<count;i++){
  if(cd.readUInt32LE(p)!==0x02014b50)throw new Error('Entrada ZIP inválida');
  const method=cd.readUInt16LE(p+10), compSize=cd.readUInt32LE(p+20), size=cd.readUInt32LE(p+24);
  const nameLen=cd.readUInt16LE(p+28), extraLen=cd.readUInt16LE(p+30), commentLen=cd.readUInt16LE(p+32), localOffset=cd.readUInt32LE(p+42);
  const name=cd.subarray(p+46,p+46+nameLen).toString('utf8');
  entries.push({name,method,compSize,size,localOffset});
  p+=46+nameLen+extraLen+commentLen;
 }
 return entries;
}
function extractEntryFromFile(file,e){
 const head=Buffer.alloc(30),fd=fs.openSync(file,'r');
 try{fs.readSync(fd,head,0,30,e.localOffset);}finally{fs.closeSync(fd);}
 if(head.readUInt32LE(0)!==0x04034b50)throw new Error('Local ZIP inválido');
 const nameLen=head.readUInt16LE(26),extraLen=head.readUInt16LE(28);
 const start=e.localOffset+30+nameLen+extraLen;
 const data=Buffer.alloc(e.compSize),fd2=fs.openSync(file,'r');
 try{fs.readSync(fd2,data,0,data.length,start);}finally{fs.closeSync(fd2);}
 if(e.method===0)return data;
 if(e.method===8)return zlib.inflateRawSync(data);
 throw new Error(`Método ZIP não suportado: ${e.method}`);
}
function processCsvText(text,onRow){
 text=text.replace(/^\uFEFF/,'');
 const nl=text.indexOf('\n');
 if(nl<0)return;
 const header=parseCsvLine(text.slice(0,nl).replace(/\r$/,'')).map(x=>x.trim());
 let start=nl+1;
 while(start<text.length){
  let end=text.indexOf('\n',start); if(end<0)end=text.length;
  let line=text.slice(start,end); if(line.endsWith('\r'))line=line.slice(0,-1);
  start=end+1;
  if(!line.trim())continue;
  const vals=parseCsvLine(line), row={};
  header.forEach((h,k)=>row[h]=vals[k]??'');
  onRow(row);
 }
}

function processZipEntryStream(file,e,onRow){
 return new Promise((resolve,reject)=>{
  const head=Buffer.alloc(30),fd=fs.openSync(file,'r');
  try{fs.readSync(fd,head,0,30,e.localOffset);}catch(err){try{fs.closeSync(fd)}catch{};reject(err);return;}finally{try{fs.closeSync(fd)}catch{}}
  if(head.readUInt32LE(0)!==0x04034b50){reject(new Error('Local ZIP inválido'));return;}
  const nameLen=head.readUInt16LE(26),extraLen=head.readUInt16LE(28);
  const start=e.localOffset+30+nameLen+extraLen,end=start+e.compSize-1;
  let stream=fs.createReadStream(file,{start,end});
  if(e.method===8)stream=stream.pipe(zlib.createInflateRaw());
  else if(e.method!==0){stream.destroy();reject(new Error(`Método ZIP não suportado: ${e.method}`));return;}
  const decoder=new StringDecoder('latin1');
  let buffer='',header=null;
  const consume=text=>{
   buffer+=text;
   let idx;
   while((idx=buffer.indexOf('\n'))>=0){
    let line=buffer.slice(0,idx);buffer=buffer.slice(idx+1);if(line.endsWith('\r'))line=line.slice(0,-1);
    if(!line.trim())continue;
    if(!header){header=parseCsvLine(line.replace(/^\uFEFF/,'' )).map(x=>x.trim());continue;}
    const vals=parseCsvLine(line),row={};header.forEach((h,k)=>row[h]=vals[k]??'');onRow(row);
   }
  };
  stream.on('data',chunk=>consume(decoder.write(chunk)));
  stream.on('end',()=>{consume(decoder.end());if(buffer.trim()&&header){const vals=parseCsvLine(buffer),row={};header.forEach((h,k)=>row[h]=vals[k]??'');onRow(row);}resolve();});
  stream.on('error',reject);
 });
}

function normalize(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}

async function buildMunicipios(){
 if(fs.existsSync(MUN_FILE)) return JSON.parse(fs.readFileSync(MUN_FILE,'utf8'));
 const raw=JSON.parse(await getText(MUNICIPIOS_URL));
 const out=[];
 for(const abr of (raw.abr||[])){
  const uf=String(abr.cd||'').toUpperCase();
  for(const m of (abr.mu||[])){
   const code=String(m.cd||'').padStart(5,'0');
   const zones=[...(Array.isArray(m.z)?m.z:[])].map(z=>Number(typeof z==='object'?(z.cd??z.codigo??z.zona):z)).filter(Number.isFinite).sort((a,b)=>a-b);
   out.push({uf,code,name:m.nm,zones:[...new Set(zones)]});
  }
 }
 if(out.length<5000) throw new Error(`EA12 retornou apenas ${out.length} municípios; índice recusado.`);
 const missing=out.filter(x=>!x.zones.length).length;
 console.log(`EA12: ${out.length} municípios materializados; ${missing} sem zona.`);
 writeJsonAtomic(MUN_FILE,out);
 return out;
}
async function buildNeighborhoods(){
 if(fs.existsSync(GEO_FILE))return JSON.parse(fs.readFileSync(GEO_FILE,'utf8'));
 if(!fs.existsSync(ZIP_FILE)){
  console.log('Baixando arquivo oficial TSE de locais de votação (uma vez)...');
  await download(LOCAIS_URL,ZIP_FILE);
 }
 const entries=zipEntriesFromFile(ZIP_FILE).filter(e=>/\.csv$/i.test(e.name));
 if(!entries.length)throw new Error('Nenhum CSV encontrado no ZIP de locais de votação.');
 const all={};
 for(const e of entries){
  console.log('Processando',e.name,`(${Math.round(e.size/1024/1024)} MB descompactado)`);
  await processZipEntryStream(ZIP_FILE,e,r=>{
   const uf=String(r.SG_UF||'').trim().toUpperCase();
   const code=String(r.CD_MUNICIPIO||'').trim().padStart(5,'0');
   const bairro=String(r.NM_BAIRRO||'').trim();
   const zona=Number(r.NR_ZONA);
   if(!uf||!/^[A-Z]{2}$/.test(uf)||!/^[0-9]{5}$/.test(code)||!bairro||!Number.isFinite(zona))return;
   const key=uf+'|'+code;if(!all[key])all[key]={};const nk=normalize(bairro);
   if(!all[key][nk])all[key][nk]={name:bairro,zones:new Set()};all[key][nk].zones.add(zona);
  });
 }
 const out={};for(const [key,map] of Object.entries(all))out[key]=Object.values(map).map(x=>({name:x.name,zones:[...x.zones].sort((a,b)=>a-b)})).sort((a,b)=>normalize(a.name).localeCompare(normalize(b.name),'pt-BR'));
 writeJsonAtomic(GEO_FILE,out);return out;
}

const ALLOWED_ELECTIONS=new Set(['6257','6259']);
const ALLOWED_CARGOS=new Set(['0001','0003','0005','0006','0007','0008']);
const PUBLIC_HTML='brazil-eleicoes-2026.html';
const MAX_URL_LENGTH=4096;


function clientIp(req){
 const remote=String(req.socket.remoteAddress||'unknown');
 // The Node process binds to loopback, so X-Forwarded-For is trusted only when
 // the immediate peer is local (the expected Caddy reverse proxy).
 const local=remote==='127.0.0.1'||remote==='::1'||remote==='::ffff:127.0.0.1';
 if(local){
   const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
   if(forwarded)return forwarded;
 }
 return remote;
}
function pruneRateMap(map, now){
  if(map.size<=5000)return;
  for(const [k,v] of map){
    if(now-v.started>RATE_WINDOW_MS)map.delete(k);
  }
}
function allowFromBucket(map,req,limit){
  const now=Date.now(),ip=clientIp(req);let b=map.get(ip);
  if(!b||now-b.started>RATE_WINDOW_MS)b={started:now,count:0};
  b.count++;map.set(ip,b);pruneRateMap(map,now);
  return b.count<=limit;
}
function allowRequest(req){return allowFromBucket(rateBuckets,req,RATE_LIMIT);}
function allowExpensiveRequest(req){return allowFromBucket(expensiveRateBuckets,req,EXPENSIVE_RATE_LIMIT);}

function securityHeaders(isHtml=false){
 const headers={
   'X-Content-Type-Options':'nosniff',
   'X-Frame-Options':'DENY',
   'Referrer-Policy':'strict-origin-when-cross-origin',
   'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()',
   'Cross-Origin-Opener-Policy':'same-origin',
   'Cache-Control':'no-store',
   'Content-Security-Policy':"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; font-src 'self'; media-src 'none'; frame-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self' https://resultados.tse.jus.br https://cdn.tse.jus.br"
 };
 if(process.env.NODE_ENV==='production')headers['Strict-Transport-Security']='max-age=31536000; includeSubDomains';
 if(isHtml)headers['Content-Security-Policy']+="; upgrade-insecure-requests";
 return headers;
}
function json(res,obj,status=200){
 const body=JSON.stringify(obj);
 const headers={...securityHeaders(false),'Content-Type':'application/json; charset=utf-8'};
 res.writeHead(status,headers);res.end(body);
}
function validateResultQuery(q){
 const election=String(q.election||'');
 const cargo=String(q.cargo||'').padStart(4,'0');
 const uf=String(q.uf||'').trim().toLowerCase();
 if(!ALLOWED_ELECTIONS.has(election)){const e=new Error('Eleição inválida.');e.statusCode=400;throw e;}
 if(!ALLOWED_CARGOS.has(cargo)){const e=new Error('Cargo inválido.');e.statusCode=400;throw e;}
 if(election==='6257'&&cargo!=='0001'){const e=new Error('Cargo incompatível com esta eleição.');e.statusCode=400;throw e;}
 if(election==='6259'&&cargo==='0001'){const e=new Error('Cargo incompatível com esta eleição.');e.statusCode=400;throw e;}
 if(uf!=='br'&&!/^[a-z]{2}$/.test(uf)){const e=new Error('UF inválida.');e.statusCode=400;throw e;}
 if(q.municipio!==undefined&&!/^\d{5}$/.test(String(q.municipio))){const e=new Error('Código de município inválido.');e.statusCode=400;throw e;}
 if(q.zona!==undefined&&!/^\d{1,4}$/.test(String(q.zona))){const e=new Error('Zona inválida.');e.statusCode=400;throw e;}
 if(q.municipio===undefined&&q.zona!==undefined){const e=new Error('Zona exige município.');e.statusCode=400;throw e;}
 if(uf==='br'&&q.municipio!==undefined){const e=new Error('Município não é permitido para consultas nacionais.');e.statusCode=400;throw e;}
 return {election,cargo,uf,municipio:q.municipio,zona:q.zona};
}
function validateSectionQuery(q){
 const base=validateResultQuery(q);
 if(base.uf==='br'){const e=new Error('UF obrigatória para seção.');e.statusCode=400;throw e;}
 if(base.municipio===undefined){const e=new Error('Município obrigatório para seção.');e.statusCode=400;throw e;}
 if(q.zona===undefined||!/^[0-9]{1,4}$/.test(String(q.zona))){const e=new Error('Zona inválida.');e.statusCode=400;throw e;}
 if(q.seccao===undefined||!/^[0-9]{1,4}$/.test(String(q.seccao))){const e=new Error('Seção inválida.');e.statusCode=400;throw e;}
 return {...base,zona:Number(q.zona),secao:Number(q.seccao)};
}
function resultUrl(q){
 const election=q.election,cargo=q.cargo,uf=q.uf;
 let stem=uf;
 if(q.municipio)stem+=q.municipio;
 if(q.zona)stem+='-z'+String(q.zona).padStart(4,'0');
 return `${TSE_BASE}/${election}/dados/${uf}/${stem}-c${cargo}-e${election.padStart(6,'0')}-u.json`;
}
async function cachedResult(rawQuery){
 const q=validateResultQuery(rawQuery);
 const key=[q.election,q.cargo,q.uf,q.municipio||'',q.zona||''].join('_');
 const file=path.join(RESULT_DIR,crypto.createHash('sha256').update(key).digest('hex')+'.json');
 if(fs.existsSync(file)){
   try{return JSON.parse(fs.readFileSync(file,'utf8'));}
   catch(err){try{fs.unlinkSync(file)}catch{};console.warn('Cache de resultado inválido removido:',file);}
 }
 if(inFlightResults.has(key))return inFlightResults.get(key);
 const p=(async()=>{
   const raw=JSON.parse(await getText(resultUrl(q)));
   writeJsonAtomic(file,raw);
   return raw;
 })().finally(()=>inFlightResults.delete(key));
 inFlightResults.set(key,p);
 return p;
}

function cleanupCache(){
  try{
    const now=Date.now();
    for(const dir of [CACHE_DIR,RESULT_DIR,SECTION_DIR,BU_DIR]){
      if(!fs.existsSync(dir))continue;
      for(const name of fs.readdirSync(dir)){
        const file=path.join(dir,name);
        let st;try{st=fs.statSync(file)}catch{continue;}
        if(st.isFile()&&/\.part-[^/]+$/.test(name)&&now-st.mtimeMs>24*60*60*1000){try{fs.unlinkSync(file)}catch{}}
      }
    }
    if(fs.existsSync(RESULT_DIR)){
      const files=fs.readdirSync(RESULT_DIR).map(name=>{
        const file=path.join(RESULT_DIR,name);try{const st=fs.statSync(file);return st.isFile()?{file,size:st.size,mtime:st.mtimeMs}:null}catch{return null;}}).filter(Boolean).sort((a,b)=>b.mtime-a.mtime);
      let total=files.reduce((n,x)=>n+x.size,0);
      let remaining=files.length;
      for(let i=files.length-1;i>=0&&(remaining>MAX_RESULT_CACHE_FILES||total>MAX_RESULT_CACHE_BYTES);i--){
        try{fs.unlinkSync(files[i].file);total-=files[i].size;remaining--;}catch{}
      }
    }
  }catch(err){console.warn('Limpeza de cache falhou:',err.message);}
}


let candidatePromise=null;
async function buildCandidates(){
 if(fs.existsSync(CANDIDATOS_INDEX))return JSON.parse(fs.readFileSync(CANDIDATOS_INDEX,'utf8'));
 if(!fs.existsSync(CANDIDATOS_FILE)){
   console.log('Baixando arquivo oficial TSE de candidatos 2026 (uma vez)...');
   await download(CANDIDATOS_URL,CANDIDATOS_FILE);
 }
 const entries=zipEntriesFromFile(CANDIDATOS_FILE).filter(e=>/\.(csv|txt)$/i.test(e.name));
 if(!entries.length)throw new Error('Nenhum CSV de candidatos encontrado no ZIP oficial.');
 const map=new Map();
 for(const e of entries){
   await processZipEntryStream(CANDIDATOS_FILE,e,row=>{
     const nome=String(row.NM_URNA_CANDIDATO||row.NM_CANDIDATO||'').trim();
     const numero=String(row.NR_CANDIDATO||'').trim();
     const cargo=String(row.CD_CARGO||'').trim().padStart(4,'0');
     const cargoNome=String(row.DS_CARGO||'').trim();
     let uf=String(row.SG_UF||row.SG_UE||'').trim().toUpperCase();
     if(cargo==='0001')uf='BR';
     if(!uf)uf=e.name.match(/(?:^|[_\-])([A-Z]{2})(?:\.|[_\-]|$)/i)?.[1]?.toUpperCase()||'';
     if(!nome||!numero||!/^\d{4}$/.test(cargo)||!cargoNome||!/^[A-Z]{2}$|^BR$/.test(uf))return;
     if(!['0001','0003','0005','0006','0007','0008'].includes(cargo))return;
     const key=String(row.SQ_CANDIDATO||`${cargo}|${uf}|${numero}`);
     if(!map.has(key))map.set(key,{id:key,nome,cargo,cargoNome,uf,numero});
   });
 }
 const out=[...map.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')||a.cargo.localeCompare(b.cargo)||a.uf.localeCompare(b.uf));
 if(out.length<100)throw new Error(`O cadastro de candidatos retornou apenas ${out.length} registros.`);
 writeJsonAtomic(CANDIDATOS_INDEX,out);return out;
}
async function candidates(){
 if(!candidatePromise)candidatePromise=buildCandidates().catch(err=>{candidatePromise=null;throw err;});
 return candidatePromise;
}
async function searchCandidates(query){
 const q=normalize(query);
 if(q.length<2)return [];
 const all=await candidates();
 return all.filter(x=>normalize(x.nome).includes(q)||normalize(x.cargoNome).includes(q)||x.numero.includes(q)).slice(0,40);
}

let neighborhoodPromise=null;
async function neighborhoods(){
 if(!neighborhoodPromise)neighborhoodPromise=buildNeighborhoods().catch(err=>{neighborhoodPromise=null;throw err;});
 return neighborhoodPromise;
}
let municipiosPromise=null;
async function municipios(){
 if(!municipiosPromise)municipiosPromise=buildMunicipios().catch(err=>{municipiosPromise=null;throw err;});
 return municipiosPromise;
}

function htmlCsp(){
 const html=fs.readFileSync(path.join(ROOT,PUBLIC_HTML),'utf8');
 const style=(html.match(/<style>([\s\S]*?)<\/style>/i)||[])[1]||'';
 const script=(html.match(/<script>([\s\S]*?)<\/script>/i)||[])[1]||'';
 const hash=x=>'sha256-'+crypto.createHash('sha256').update(x).digest('base64');
 return "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; font-src 'self'; media-src 'none'; frame-src 'none'; " +
   "style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self' '"+hash(script)+"'; " +
   "connect-src 'self' https://resultados.tse.jus.br https://cdn.tse.jus.br; upgrade-insecure-requests";
}

const server=http.createServer(async(req,res)=>{
 try{
  if(req.url && req.url.length>MAX_URL_LENGTH){
   res.writeHead(414,{...securityHeaders(false),'Content-Type':'text/plain; charset=utf-8'});return res.end('URI Too Long');
  }
  if(req.method!=='GET'){
   res.writeHead(405,{...securityHeaders(false),'Allow':'GET','Content-Type':'text/plain; charset=utf-8'});return res.end('Method Not Allowed');
  }
  if(!allowRequest(req))return json(res,{error:'Muitas requisições. Tente novamente em instantes.'},429);
  const u=new URL(req.url,`http://localhost:${PORT}`);
  if(u.pathname==='/api/health'){let cacheWritable=false;try{fs.accessSync(CACHE_DIR,fs.constants.W_OK);cacheWritable=true;}catch(_e){}const mem=process.memoryUsage();return json(res,{ok:cacheWritable,version:APP_VERSION,environment:NODE_ENV,uptimeSeconds:Math.floor(process.uptime()),cacheWritable,inFlightResults:inFlightResults.size,expensiveActive,expensiveQueued:expensiveQueue.length,memoryMb:{rss:Math.round(mem.rss/1048576),heapUsed:Math.round(mem.heapUsed/1048576)}});}
  if(u.pathname==='/api/version')return json(res,{name:'BR Eleições 2026',version:APP_VERSION,environment:NODE_ENV});
  if(u.pathname==='/api/municipios')return json(res,await municipios());
  if(u.pathname==='/api/candidates'){const q=String(u.searchParams.get('q')||'').trim();return json(res,await searchCandidates(q));}
  if(u.pathname==='/api/section-result'){if(!allowExpensiveRequest(req))return json(res,{error:'Muitas consultas detalhadas. Tente novamente em instantes.'},429);const q=Object.fromEntries(u.searchParams.entries());return json(res,await sectionResult(q));}
  if(u.pathname==='/api/sections'){if(!allowExpensiveRequest(req))return json(res,{error:'Muitas consultas detalhadas. Tente novamente em instantes.'},429);const uf=String(u.searchParams.get('uf')||'').trim().toUpperCase(),municipio=String(u.searchParams.get('municipio')||'').trim();if(!/^[A-Z]{2}$/.test(uf)||!/^[0-9]{5}$/.test(municipio))return json(res,{error:'UF ou município inválido.'},400);const cities=await municipios();if(!cities.some(x=>x.uf===uf&&x.code===municipio))return json(res,{error:'Município não encontrado.'},400);return json(res,await buildSectionsForMunicipio(uf,municipio));}
  if(u.pathname==='/api/result'){
   const q=Object.fromEntries(u.searchParams.entries());
   return json(res,await cachedResult(q));
  }
  // The national neighborhood build is intentionally not exposed as a public
  // endpoint: it is expensive and the browser now loads only the selected city.
  if(u.pathname==='/api/neighborhoods'||u.pathname==='/api/bootstrap')return json(res,{error:'Endpoint não disponível.'},404);

  if(u.pathname==='/brazil-eleicoes-2026.css'){
   const cssFile=path.join(ROOT,'brazil-eleicoes-2026.css');
   const body=fs.readFileSync(cssFile,'utf8');
   const headers={...securityHeaders(false),'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store'};
   res.writeHead(200,headers);res.end(body);return;
  }

  // Only the public HTML is served. This prevents accidental exposure of
  // server.js, caches, backups, configuration files or arbitrary paths.
  if(u.pathname!=='/'&&u.pathname!=='/'+PUBLIC_HTML){
   res.writeHead(404,{...securityHeaders(false),'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found');
  }
  const file=path.join(ROOT,PUBLIC_HTML);
  const body=fs.readFileSync(file,'utf8');
  const headers={...securityHeaders(true),'Content-Security-Policy':htmlCsp(),'Content-Type':'text/html; charset=utf-8'};
  res.writeHead(200,headers);res.end(body);
 }catch(e){
  if(e.statusCode!==400)console.error(e);
  json(res,{error:e.statusCode===400?e.message:'Não foi possível concluir a solicitação.'},e.statusCode===400?400:500);
 }
});
server.headersTimeout=10_000;
server.requestTimeout=30_000;
server.keepAliveTimeout=5_000;

let shuttingDown=false;
function shutdown(signal){
 if(shuttingDown)return;
 shuttingDown=true;
 console.log(`Recebido ${signal}; encerrando servidor...`);
 server.close(()=>process.exit(0));
 setTimeout(()=>process.exit(1),10_000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('unhandledRejection',err=>console.error('Unhandled rejection:',err));
process.on('uncaughtException',err=>{console.error('Uncaught exception:',err);shutdown('uncaughtException');});

cleanupCache();
const cacheCleanupTimer=setInterval(cleanupCache,CACHE_CLEANUP_INTERVAL_MS);
cacheCleanupTimer.unref();
server.listen(PORT,HOST,()=>console.log(`BR Eleições 2026 v${APP_VERSION} (${NODE_ENV}): http://${HOST}:${PORT}/brazil-eleicoes-2026.html`));
