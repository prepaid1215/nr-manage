import{supabase}from'./supabase.js?v=20260829-34';
const CLOUD_SYNC='https://nrc-sync-cloud-sg.onrender.com';
// 방문개통 요청서는 클라우드 백엔드의 네이버 CLOVA OCR을 우선 시도하고,
// 아직 설정 전이거나 요청이 실패하면 호출부에서 로컬 Tesseract로 대체한다.
async function cloudOcrVisitForm(file){
  const{data:{session}}=await supabase.auth.getSession();
  if(!session)throw Error('앱 로그인 세션이 만료되었습니다. 다시 로그인해 주세요.');
  const formData=new FormData();
  formData.append('image',file,file.name||'visit-form.jpg');
  const response=await fetch(`${CLOUD_SYNC}/ocr/visit-form`,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`},body:formData});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.ok)throw Error(data.message||'클라우드 OCR 요청에 실패했습니다.');
  return data.text||'';
}
import{localDate}from'./date.js?v=20260829-25';
import{friendlyError}from'./errors.js?v=20260830-1';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let rechargeCycleDays=Number(localStorage.getItem('nrc-recharge-cycle')||30);
const dueInfo=value=>{if(!value)return null;const [y,m,d]=value.split('-').map(Number),today=new Date();today.setHours(0,0,0,0);let due=new Date(y,m-1,d);due.setDate(due.getDate()+rechargeCycleDays);while(due<today)due.setDate(due.getDate()+rechargeCycleDays);const diff=Math.round((due-today)/86400000),date=`${due.getFullYear()}-${String(due.getMonth()+1).padStart(2,'0')}-${String(due.getDate()).padStart(2,'0')}`;return{diff,date,label:diff===0?'D-DAY':`D-${diff}`,alert:diff<=3}};
const phone=value=>{const d=String(value||'').replace(/\D/g,'');return d.length===11?`${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`:d.length===10?`${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`:value||''};
function parseActivation(text){const field=label=>text.match(new RegExp(`${label}\\s*[:：]\\s*([^\\n\\r]+)`,'i'))?.[1]?.trim()||'',phones=(text.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g)||[]).map(phone),carrier=/LG/i.test(text)?'LG U+':/SKT|SK텔레콤/i.test(text)?'SKT':/\bKT\b|케이티/i.test(text)?'KT':'';return{process_no:field('처리번호'),network:carrier,activation_type:/번호\s*이동/.test(text)?'번호이동':/기기\s*변경/.test(text)?'기기변경':'신규',subscription_type:/후\s*불/.test(text)?'후불':'선불',plan:field('가입\\s*요금제'),name:field('이름'),phone:phones[0]||field('개통번호'),contact_phone:phones[1]||field('연락번호')}}
// 앤텔레콤 "센터방문 개통 요청서" 양식 OCR용 파서. 체크박스(V/☑ 등)는 인식률이
// 낮아 최선 추정치이며, 전화번호는 이 양식 단계에선 아직 없어 채우지 않는다.
const VISIT_FORM_LABELS=['성명','생년월일','연락번호','회원번호','회원명','매출자','정보','명의자','통신망','선택','가입요금제','가입','요금제','사전','설명','필수','신규개통','번호이동','신규','개통','방문','예약','시간','특이사항'];
const VISIT_TIME_LIKE=/\d+\s*월|\d+\s*일|오전|오후|\d+\s*시|\d+\s*분/;
const koreanTokensOf=text=>(text.match(/[가-힣]{2,6}/g)||[]).filter(t=>!VISIT_FORM_LABELS.includes(t));
// sellerBlockText/rateBlockText는 앵커 기반으로 잘라 확대 재인식한 구간
// 텍스트(ocrVisitForm 참고). 있으면 그쪽을 우선 쓰고, 없으면 전체 텍스트
// 라인 탐색으로 되돌아간다(이전 방식, 정확도는 더 낮음).
function parseVisitForm(text,sellerBlockText='',rateBlockText=''){
  const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const norm=text.replace(/\s+/g,' ');
  const checkedNear=(src,re)=>new RegExp(`[✓VvⅤ☑■✔]\\s{0,3}${re}`).test(src);
  const rateNorm=rateBlockText.replace(/\s+/g,' ');
  const network=checkedNear(rateNorm,'L\\s*망')?'LG U+':checkedNear(rateNorm,'K\\s*망')?'KT':checkedNear(norm,'L\\s*망')?'LG U+':checkedNear(norm,'K\\s*망')?'KT':'';
  const subscription_type=checkedNear(norm,'후\\s*불')&&!checkedNear(norm,'선\\s*불')?'후불':'선불';
  const activation_type=checkedNear(norm,'번호\\s*이동')&&!checkedNear(norm,'신규\\s*개통')?'번호이동':'신규';
  // 표 형식 양식이라 라벨 줄 다음 줄에 실제 값이 오는 경우가 많지만, 사진
  // OCR는 칸을 블록 단위로 뒤섞어 읽기도 해서 창을 넓게 보고 다른 필드
  // 값(reject)이 잘못 섞여 들어오지 않게 걸러낸다.
  const valueAfter=(labelRe,tokenRe,{window=4,reject}={})=>{
    const idx=lines.findIndex(l=>labelRe.test(l));
    if(idx<0)return'';
    for(let i=idx;i<Math.min(idx+window,lines.length);i++){
      const tokens=lines[i].match(tokenRe)||[];
      const hit=tokens.find(t=>!VISIT_FORM_LABELS.includes(t)&&!labelRe.test(t)&&!(reject&&reject(t)));
      if(hit)return hit;
    }
    return'';
  };
  const visit_time=valueAfter(/방문\s*예약\s*시간/,/[0-9][0-9월일시분\s가-힣APap:]{1,18}/g,{window:5}).trim();
  const sellerTokens=koreanTokensOf(sellerBlockText);
  const member_no=(sellerBlockText.match(/\d{6,8}/)||[])[0]||valueAfter(/매출자\s*정보|회원번호/,/\d{6,8}/g,{window:6});
  const seller=sellerTokens[0]||valueAfter(/매출자\s*정보|회원명/,/[가-힣]{2,6}/g,{window:6});
  const name=sellerTokens[1]||valueAfter(/명의자\s*성명/,/[가-힣]{2,6}/g,{window:6,reject:t=>t===seller});
  const rateToken=(rateBlockText.match(/[0-9][0-9가-힣.\s]{1,18}[0-9가-힣]/g)||[]).map(t=>t.trim()).find(t=>!VISIT_TIME_LIKE.test(t)&&!VISIT_FORM_LABELS.includes(t));
  const plan=rateToken||valueAfter(/가입\s*요금제/,/[0-9][0-9가-힣.\s]{1,18}[0-9가-힣]/g,{window:6,reject:t=>t===visit_time||VISIT_TIME_LIKE.test(t)}).trim();
  const memoLine=valueAfter(/특이사항/,/.+/g,{window:5});
  const memo=memoLine==='-'?'':memoLine;
  return{network,subscription_type,activation_type,name,plan,member_no,seller,visit_time,memo};
}
// 방문개통 요청서 표 글씨는 원본 그대로 Tesseract에 넣으면 일부 줄이
// 통째로 누락되기도 한다. 확대 + Otsu 기준 흑백 이진화로 인식률을 올린다.
function otsuThreshold(gray,len){
  const hist=new Array(256).fill(0);
  for(let i=0;i<len;i++)hist[gray[i]]++;
  let sum=0;for(let t=0;t<256;t++)sum+=t*hist[t];
  let sumB=0,wB=0,varMax=0,threshold=127;
  for(let t=0;t<256;t++){
    wB+=hist[t];if(!wB)continue;
    const wF=len-wB;if(!wF)break;
    sumB+=t*hist[t];
    const mB=sumB/wB,mF=(sum-sumB)/wF,varBetween=wB*wF*(mB-mF)*(mB-mF);
    if(varBetween>varMax){varMax=varBetween;threshold=t}
  }
  return threshold;
}
async function preprocessVisitCanvas(file){
  const bitmap=await createImageBitmap(file);
  const scale=Math.min(3,Math.max(1,1800/bitmap.width));
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(bitmap.width*scale);
  canvas.height=Math.round(bitmap.height*scale);
  const ctx=canvas.getContext('2d');
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const img=ctx.getImageData(0,0,canvas.width,canvas.height),data=img.data,pixelCount=data.length/4,gray=new Uint8ClampedArray(pixelCount);
  for(let i=0,p=0;i<data.length;i+=4,p++)gray[p]=data[i]*0.299+data[i+1]*0.587+data[i+2]*0.114;
  const threshold=otsuThreshold(gray,pixelCount);
  for(let i=0,p=0;i<data.length;i+=4,p++){
    const bw=gray[p]<threshold?0:255;
    data[i]=data[i+1]=data[i+2]=bw;
  }
  ctx.putImageData(img,0,0);
  return canvas;
}
const canvasToBlob=canvas=>new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
function cropCanvasRegion(sourceCanvas,top,bottom,upscale=3){
  const w=sourceCanvas.width,h=Math.max(1,Math.round(Math.min(bottom,sourceCanvas.height)-Math.max(0,top)));
  const canvas=document.createElement('canvas');
  canvas.width=w*upscale;canvas.height=h*upscale;
  const ctx=canvas.getContext('2d');
  ctx.imageSmoothingEnabled=false;
  ctx.drawImage(sourceCanvas,0,Math.max(0,top),w,h,0,0,canvas.width,canvas.height);
  return canvas;
}
function findAnchorBbox(words,patterns){
  for(const w of words||[]){
    const t=(w.text||'').replace(/\s+/g,'');
    if(patterns.some(p=>t.includes(p)))return w.bbox;
  }
  return null;
}
// 라벨(매출자/통신망/방문 등)은 전체 페이지 OCR에서도 곧잘 읽히지만 그
// 옆/아래 값 칸은 통째로 누락되는 경우가 많았다. 1차 인식에서 찾은 라벨
// 위치를 기준으로 그 구간만 잘라 확대해서 2차로 다시 읽는다.
async function ocrVisitForm(file,Tesseract,onProgress){
  const preCanvas=await preprocessVisitCanvas(file);
  const blob1=await canvasToBlob(preCanvas);
  const result1=await Tesseract.recognize(blob1,'kor+eng',{logger:onProgress});
  const fullText=result1.data.text||'';
  const words=result1.data.words||result1.data.lines?.flatMap(l=>l.words||[])||[];
  const anchorSeller=findAnchorBbox(words,['매출자','정보']);
  const anchorRate=findAnchorBbox(words,['통신망','가입요금제','요금제']);
  const anchorVisit=findAnchorBbox(words,['방문예약','방문','예약시간']);
  const rowHeight=anchorSeller?Math.max(20,anchorSeller.y1-anchorSeller.y0):40;
  let sellerBlockText='',rateBlockText='';
  if(anchorSeller){
    const top=Math.max(0,anchorSeller.y0-rowHeight*0.6);
    const bottom=anchorRate?Math.max(top+rowHeight,anchorRate.y0-rowHeight*0.3):anchorSeller.y1+rowHeight*4.5;
    try{const crop=cropCanvasRegion(preCanvas,top,bottom),blob=await canvasToBlob(crop),r=await Tesseract.recognize(blob,'kor+eng',{});sellerBlockText=r.data.text||''}catch{}
  }
  if(anchorRate){
    const top=anchorRate.y1+rowHeight*0.2;
    const bottom=anchorVisit?Math.max(top+rowHeight,anchorVisit.y0-rowHeight*0.3):anchorRate.y1+rowHeight*3;
    try{const crop=cropCanvasRegion(preCanvas,top,bottom),blob=await canvasToBlob(crop),r=await Tesseract.recognize(blob,'kor+eng',{});rateBlockText=r.data.text||''}catch{}
  }
  return{fullText,sellerBlockText,rateBlockText};
}
let ocrLoader;
const loadOcr=()=>window.Tesseract?Promise.resolve(window.Tesseract):(ocrLoader||=(new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';script.onload=()=>resolve(window.Tesseract);script.onerror=()=>reject(Error('OCR 모듈을 불러오지 못했습니다.'));document.head.appendChild(script)})));
let xlsxLoader;
const loadXlsx=()=>window.XLSX?Promise.resolve(window.XLSX):(xlsxLoader||=(new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';script.onload=()=>resolve(window.XLSX);script.onerror=()=>reject(Error('엑셀 모듈을 불러오지 못했습니다.'));document.head.appendChild(script)})));
const transferDateStr=value=>{
  if(value instanceof Date&&!isNaN(value))return`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  const text=String(value||'').trim(),m=text.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:'';
};
const transferFieldOf=value=>/재구매|재충전|repurchase/i.test(String(value||''))?'repurchase':'new_transfer';
const backupBlocks=text=>text.split(/(?=처리번호\s*[:：])/).map(parseActivation).filter(item=>item.name||item.phone);
const contractInfo=row=>{const months=Number(row.contract_months||0);if(!months||!row.activation_date)return null;const [y,m,d]=row.activation_date.split('-').map(Number),end=new Date(y,m-1+months,d),today=new Date();today.setHours(0,0,0,0);const diff=Math.ceil((end-today)/86400000),date=`${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;return{diff,date,label:diff<0?`만료+${Math.abs(diff)}`:diff===0?'만료 D-DAY':`만료 D-${diff}`,alert:diff<=30}};
const saveVcard=row=>{const content=`BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${row.name||''}\r\nTEL;TYPE=CELL:${row.contact_phone||row.phone||''}\r\nNOTE:${[row.network,row.plan,row.memo].filter(Boolean).join(' / ').replace(/\n/g,' ')}\r\nEND:VCARD`,url=URL.createObjectURL(new Blob([content],{type:'text/vcard;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`${row.name||'고객'}.vcf`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
const download=(name,content,type)=>{const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
const loadFavSellers=async ownerId=>{const{data,error}=await supabase.from('fav_sellers').select('id,member_no,name').eq('owner_id',ownerId).order('created_at');if(error)return[];return data||[]};
const addFavSeller=(ownerId,no,name)=>supabase.from('fav_sellers').insert({owner_id:ownerId,member_no:no,name});
const delFavSeller=id=>supabase.from('fav_sellers').delete().eq('id',id);
export async function customersPage(root,me,options){
  root.innerHTML=`<section class="card"><div class="section-head"><div><h2>고객 관리</h2><p class="help">내 고객과 공유 허용된 팀 고객을 관리합니다.</p></div><div class="customer-header-actions"><button class="primary compact" id="customerAdd">+ 고객 등록</button></div></div><div class="customer-quick-actions"><button class="secondary compact" id="transferAdd">+ 신규개통양도</button><button class="secondary compact" id="repurchaseAdd">+ 재구매양도</button><button class="secondary compact" id="transferImport">📥 엑셀로 가져오기</button><button class="secondary compact" id="transferTemplate">📄 양식 다운로드</button><input id="transferImportFile" type="file" accept=".xlsx,.xls,.csv" hidden></div><p id="transferImportStatus" class="connection-status" hidden></p><div id="transferUndo" class="connection-status" hidden></div><details class="transfer-history"><summary>최근 양도 기록</summary><div id="transferList" class="transfer-list"></div></details><div class="view-tabs"><button class="active" data-scope="mine">내 고객</button><button data-scope="shared">공유 고객</button><button id="dueOnly">🔔 알림 대상만</button></div><div class="customer-tools"><input id="customerSearch" type="search" placeholder="이름·전화번호·회원번호 검색"><select id="customerNetwork"><option value="">전체 통신사</option><option>KT</option><option>LG U+</option><option>SKT</option><option>알뜰폰</option></select></div><div id="customerSummary" class="org-summary"></div><div id="customerError" class="error"></div><div id="customerList" class="customer-list"></div></section><dialog id="customerDialog" class="customer-dialog"><form id="customerForm"><div class="dialog-head"><h2 id="customerTitle">고객 등록</h2><button id="customerClose" type="button">×</button></div><div class="customer-form"><input id="cId" type="hidden"><label>개통일<input id="cDate" type="date"></label><label>고객명<input id="cName" required></label><label>전화번호<input id="cPhone" type="tel"></label><label>통신사<select id="cNetwork"><option value="">선택</option><option>KT</option><option>LG U+</option><option>SKT</option><option>알뜰폰</option></select></label><label>요금제<input id="cPlan"></label><label>개통유형<select id="cType"><option>신규</option><option>번호이동</option><option>기기변경</option></select></label><label>개통방법<select id="cMethod"><option>플랫폼</option><option>앤스마트</option><option>지점방문</option></select></label><label>유입경로<input id="cSource"></label><label class="full">메모<textarea id="cMemo" rows="3"></textarea></label><div class="full" id="sellerBlock" hidden><label>회원번호<input id="cMember"></label><label>매출자<input id="cSeller" placeholder="예: 주땡땡"></label><div class="fav-sellers-block"><div class="fav-header"><span>⭐ 자주 쓰는 매출자 (클릭시 즉시 입력)</span><button class="secondary compact" id="favSellerSave" type="button">현재 정보 저장</button></div><div id="favSellerList" class="fav-list"></div></div></div></div><div class="customer-actions"><button class="secondary" id="customerCancel" type="button">취소</button><button class="primary" type="submit">저장</button></div></form></dialog><dialog id="amountDialog" class="customer-dialog small"><form id="amountForm"><div class="dialog-head"><h2 id="amountTitle">금액 입력</h2><button id="amountClose" type="button">×</button></div><p id="amountHint" class="help"></p><div id="amountCustomerBlock" hidden><label>고객 검색<input id="amountCustomerSearch" type="search" placeholder="이름·전화번호·회원번호로 검색"></label><div id="amountCustomerMatches" class="repurchase-matches"></div><p id="amountCustomerSelected" class="help"></p><button class="secondary compact" id="amountSkipCustomer" type="button">이름 없이 저장</button></div><label>날짜<input id="amountDate" type="date"></label><label>금액(원)<input id="amountValue" type="number" min="0" step="1000"></label><div class="customer-actions"><button class="secondary" id="amountSkip" type="button">건너뛰기</button><button class="primary" type="submit">저장</button></div></form></dialog><dialog id="repurchaseDialog" class="customer-dialog small"><div class="dialog-head"><h2>재구매 등록</h2><button id="repurchaseClose" type="button">×</button></div><label>전화번호 뒷자리<input id="repurchasePhone" inputmode="numeric" placeholder="예: 1234" maxlength="4"></label><div id="repurchaseMatches" class="repurchase-matches"></div><button class="secondary compact repurchase-skip" id="repurchaseSkip" type="button">번호 없이 입력</button><form id="repurchaseAmountForm" hidden><p id="repurchaseSelected" class="help"></p><label>날짜<input id="repurchaseDate" type="date"></label><label>재구매 금액(원)<input id="repurchaseValue" type="number" min="0" step="1000" required></label><div class="customer-actions"><button class="secondary" id="repurchaseBack" type="button">다시 검색</button><button class="primary" type="submit">저장</button></div></form></dialog>`;
  const $=id=>document.getElementById(id),dialog=$('customerDialog'),amountDialog=$('amountDialog'),repurchaseDialog=$('repurchaseDialog'),viewOwner=options?.viewOwner||null;let rows=[],scope='mine',alertsOnly=false,repurchaseTarget=null;
  if(viewOwner){
    root.querySelector('.customer-header-actions').hidden=true;
    root.querySelector('.customer-quick-actions').hidden=true;
    root.querySelector('.view-tabs').hidden=true;
    root.querySelector('h2').textContent=`${viewOwner.name} 고객 목록`;
    root.querySelector('.section-head p.help').textContent='NRC 하위 사업자 자료를 읽기 전용으로 보고 있습니다.';
    root.querySelector('.section-head').insertAdjacentHTML('beforeend','<button class="secondary compact" id="viewOwnerBack" type="button">← 조직으로</button>');
    $('viewOwnerBack').onclick=()=>document.querySelector('[data-page="organization"]')?.click();
  }
  async function bumpDailyActivity(field,amount,date=localDate()){
    if(!amount)return;
    const{data:existing}=await supabase.from('daily_activities').select(field).eq('owner_id',me.id).eq('activity_date',date).maybeSingle();
    const next=Number(existing?.[field]||0)+Number(amount);
    return supabase.from('daily_activities').upsert({owner_id:me.id,activity_date:date,[field]:next,updated_at:new Date().toISOString()},{onConflict:'owner_id,activity_date'});
  }
  const transferFieldLabel=field=>field==='new_transfer'?'신규개통양도':'재구매양도';
  // 신규개통양도/재구매양도를 건별로(누구에게 얼마) transfer_records에
  // 남긴다. daily_activities 총액도 같이 올려서 홈/마감 화면은 그대로
  // 동작한다. RUN_032_TRANSFER_RECORDS.sql을 실행하지 않은 계정이면
  // 총액만 올라가고 건별 기록은 조용히 건너뛴다.
  async function recordTransfer(field,amount,customer,date=localDate()){
    if(!amount)return null;
    await bumpDailyActivity(field,amount,date);
    const{data,error}=await supabase.from('transfer_records').insert({
      owner_id:me.id,activity_date:date,field,
      customer_id:customer?.id||null,customer_name:customer?.name||null,amount,
    }).select().single();
    offerTransferUndo(field,amount,transferFieldLabel(field),error?null:data?.id,date);
    renderTransferList();
    return error?null:data;
  }
  const undoBox=$('transferUndo');
  const offerTransferUndo=(field,amount,label,recordId,date=localDate())=>{
    if(!undoBox||!amount)return;
    undoBox.hidden=false;
    const dateLabel=date===localDate()?'오늘':date;
    undoBox.innerHTML=`${label} ${amount.toLocaleString('ko-KR')}원을 ${dateLabel} 기록에 더했습니다. <button class="secondary compact" id="transferUndoBtn" type="button">방금 추가 취소</button>`;
    $('transferUndoBtn').onclick=async()=>{
      await bumpDailyActivity(field,-amount,date);
      if(recordId)await supabase.from('transfer_records').delete().eq('id',recordId);
      undoBox.hidden=true;
      undoBox.innerHTML='';
      renderTransferList();
    };
  };
  async function loadTransferRecords(){
    const{data,error}=await supabase.from('transfer_records').select('*').eq('owner_id',me.id).order('created_at',{ascending:false}).limit(20);
    return error?[]:(data||[]);
  }
  async function renderTransferList(){
    const box=$('transferList');
    if(!box)return;
    const list=await loadTransferRecords();
    box.innerHTML=list.length?list.map(r=>`<article class="transfer-item"><div><b>${esc(r.customer_name||'이름 없음')}</b><small>${esc(transferFieldLabel(r.field))} · ${esc(r.activity_date)} · ${Number(r.amount).toLocaleString('ko-KR')}원</small></div><button class="customer-delete" data-del-transfer="${esc(r.id)}" type="button">취소</button></article>`).join(''):'<p class="help">최근 양도 기록이 없습니다. (RUN_032_TRANSFER_RECORDS.sql을 아직 실행 안 하셨다면 여기 목록만 비어 있고, 총액은 정상 반영됩니다.)</p>';
    box.querySelectorAll('[data-del-transfer]').forEach(btn=>btn.onclick=async()=>{
      const record=list.find(r=>r.id===btn.dataset.delTransfer);
      if(!record||!confirm(`${record.customer_name||'이름 없음'} · ${Number(record.amount).toLocaleString('ko-KR')}원 기록을 취소할까요? 그날 총액에서도 빠집니다.`))return;
      await bumpDailyActivity(record.field,-Number(record.amount),record.activity_date);
      await supabase.from('transfer_records').delete().eq('id',record.id);
      renderTransferList();
    });
  }
  // 엑셀/CSV로 신규개통양도·재구매양도를 한꺼번에 넣는다. 고객명은 이름이
  // 정확히 일치하는 기존 고객이 있으면 자동으로 연결하고, 없으면 이름
  // 텍스트만 남긴다(customer_id는 비움).
  async function importTransferRows(items){
    const inserts=items.map(item=>{
      const matched=item.customerName&&rows.find(r=>r.owner_id===me.id&&r.name&&r.name.trim()===item.customerName.trim());
      return{owner_id:me.id,activity_date:item.date,field:item.field,customer_id:matched?.id||null,customer_name:item.customerName||matched?.name||null,amount:item.amount};
    });
    const{error}=await supabase.from('transfer_records').insert(inserts);
    if(error)throw error;
    const groups=new Map();
    inserts.forEach(row=>{
      const key=`${row.activity_date}|${row.field}`;
      groups.set(key,(groups.get(key)||0)+Number(row.amount));
    });
    for(const[key,sum]of groups){
      const[date,field]=key.split('|');
      await bumpDailyActivity(field,sum,date);
    }
  }
  const renderAmountCustomerMatches=query=>{
    const box=$('amountCustomerMatches'),q=query.trim().toLowerCase();
    if(!q){box.innerHTML='';return}
    const matches=rows.filter(r=>r.owner_id===me.id&&[r.name,r.phone,r.member_no].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,8);
    box.innerHTML=matches.length?matches.map(r=>`<button type="button" class="repurchase-match" data-pick-customer="${esc(r.id)}">${esc(r.name)} <small>${esc(phone(r.phone))}</small></button>`).join(''):'<p class="help">일치하는 고객이 없습니다.</p>';
    box.querySelectorAll('[data-pick-customer]').forEach(btn=>btn.onclick=()=>{
      const picked=rows.find(r=>r.id===btn.dataset.pickCustomer);
      amountCustomer=picked?{id:picked.id,name:picked.name}:null;
      $('amountCustomerSelected').textContent=picked?`선택됨: ${picked.name}`:'';
      box.innerHTML='';
    });
  };
  let amountCustomer=null;
  const askAmount=(title,hint,opts={})=>new Promise(resolve=>{
    $('amountTitle').textContent=title;$('amountHint').textContent=hint;$('amountValue').value='';$('amountDate').value=opts.date||localDate();
    const needCustomer=Boolean(opts.needCustomer);
    amountCustomer=opts.presetCustomer||null;
    $('amountCustomerBlock').hidden=!needCustomer;
    $('amountCustomerSearch').value='';$('amountCustomerMatches').innerHTML='';
    $('amountCustomerSelected').textContent=amountCustomer?`선택됨: ${amountCustomer.name}`:'';
    let settled=false;
    const done=value=>{if(settled)return;settled=true;resolve(value);if(amountDialog.open)amountDialog.close()};
    $('amountForm').onsubmit=e=>{
      e.preventDefault();
      if(needCustomer&&amountCustomer===null){alert('고객을 검색해서 선택하거나, "이름 없이 저장"을 눌러주세요.');return}
      done({amount:Number($('amountValue').value||0),customer:amountCustomer,date:$('amountDate').value||localDate()});
    };
    $('amountCustomerSearch').oninput=()=>renderAmountCustomerMatches($('amountCustomerSearch').value);
    $('amountSkipCustomer').onclick=()=>{amountCustomer={id:null,name:null};$('amountCustomerSelected').textContent='이름 없이 저장'};
    $('amountSkip').onclick=()=>done(null);
    $('amountClose').onclick=()=>done(null);
    amountDialog.onclose=()=>done(null);
    amountDialog.showModal();
  });
  if(!viewOwner)root.querySelector('.customer-tools').insertAdjacentHTML('afterend',`<div class="customer-export-tools"><label>충전주기 <input id="cycleDays" type="number" min="1" value="${rechargeCycleDays}"></label><button id="exportVcf" type="button">📇 전체 연락처</button><button id="exportCsv" type="button">📊 CSV 내보내기</button><button id="exportJson" type="button">💾 JSON 백업</button><button id="importJson" type="button">📂 JSON 복원</button><input id="importJsonFile" type="file" accept="application/json,.json" hidden></div>`);
  dialog.querySelector('.customer-form').insertAdjacentHTML('beforebegin',`<div class="customer-entry-tabs"><button class="active" data-entry="paste" type="button">📋 카톡 문자 붙여넣기</button><button data-entry="direct" type="button">✍️ 직접 작성</button><button data-entry="capture" type="button">🖼️ 카톡 캡처본</button><button data-entry="visit" type="button">🏢 방문개통</button><button data-entry="backup" type="button">📄 카톡 백업본</button></div><div id="entryImport" class="entry-import"><textarea id="entryText" rows="7" placeholder="처리번호: 20260727000018\n통신사: LGU\n가입구분: 신규가입\n가입유형: 선불\n가입 요금제: 선불 LTE 기본1\n이름: 주땡땡\n개통번호: 010-0000-0000"></textarea><input id="entryFile" type="file" accept=".txt,image/*" hidden><button class="primary" id="entryParse" type="button">붙여넣은 텍스트로 채우기</button><p id="entryHint" class="help">카톡 메시지를 그대로 붙여넣으면 아래 항목을 자동으로 채웁니다.</p></div>`);
  $('cPhone').closest('label').insertAdjacentHTML('afterend',`<label>연락번호<input id="cContactPhone" type="tel"></label><label>가입유형<select id="cSubscription"><option>선불</option><option>후불</option></select></label>`);$('cSource').closest('label').insertAdjacentHTML('afterend',`<label>담당<input id="cManager"></label><label>약정기간<select id="cContract"><option value="0">없음</option><option value="6">6개월</option><option value="12">12개월</option><option value="24">24개월</option></select></label><input id="cProcess" type="hidden">`);
  const renderFavSellers=async()=>{const list=await loadFavSellers(me.id);$('favSellerList').innerHTML=list.length?list.map(item=>`<span class="fav-chip" data-fav="${item.id}">${esc(item.name)}<i class="del" data-fav-del="${item.id}">×</i></span>`).join(''):'<span class="help">등록된 매출자가 없습니다.</span>';
    $('favSellerList').querySelectorAll('[data-fav]').forEach(chip=>chip.onclick=e=>{if(e.target.closest('[data-fav-del]'))return;const item=list.find(i=>i.id===chip.dataset.fav);$('cMember').value=item.member_no;$('cSeller').value=item.name});
    $('favSellerList').querySelectorAll('[data-fav-del]').forEach(btn=>btn.onclick=async e=>{e.stopPropagation();await delFavSeller(btn.dataset.favDel);renderFavSellers()})};
  $('favSellerSave').onclick=async()=>{const no=$('cMember').value.trim(),name=$('cSeller').value.trim();if(!no||!name)return alert('회원번호와 매출자를 입력 후 버튼을 눌러주세요.');const{error}=await addFavSeller(me.id,no,name);if(error)return alert(/duplicate|unique/i.test(error.message)?'이미 등록된 회원번호입니다.':friendlyError(error));renderFavSellers()};
  renderFavSellers();
  $('cMethod').closest('label').hidden=true;$('cMethod').closest('label').insertAdjacentHTML('afterend',`<div class="full choice-block"><span>개통방법</span><div class="choice-row" data-choice="cMethod"><button data-value="플랫폼" type="button">플랫폼</button><button data-value="앤스마트" type="button">앤스마트</button><button data-value="지점방문" type="button">지점방문</button></div></div>`);$('cSource').closest('label').hidden=true;$('cSource').closest('label').insertAdjacentHTML('afterend',`<div class="full choice-block"><span>루트(유입경로)</span><div class="choice-grid" data-choice="cSource">${['메인블로그','슬룸','유튜브','당근','인스타','스레드','광고','오픈채팅','워드프레스','티스토리','네이버플레이스','카페','기타'].map(v=>`<button data-value="${v}" type="button">${v}</button>`).join('')}</div></div>`);$('cMemo').closest('label').insertAdjacentHTML('afterend',`<label class="full">등록 담당자<input id="cAuthor" value="${esc(me.name||'담당자')}" readonly></label>`);
  const render=()=>{const q=$('customerSearch').value.trim().toLowerCase(),network=$('customerNetwork').value,scoped=rows.filter(r=>viewOwner?r.owner_id===viewOwner.id:scope==='mine'?r.owner_id===me.id:r.owner_id!==me.id),alertCount=scoped.filter(r=>dueInfo(r.activation_date)?.alert).length;const shown=scoped.filter(r=>(!alertsOnly||dueInfo(r.activation_date)?.alert)&&(!network||r.network===network)&&(!q||[r.name,r.phone,r.member_no].some(v=>String(v||'').toLowerCase().includes(q))));$('customerSummary').innerHTML=`<article><span>표시 고객</span><b>${shown.length}명</b></article><article><span>충전 알림</span><b>${alertCount}명</b></article><article><span>KT / LG</span><b>${shown.filter(r=>r.network==='KT').length} / ${shown.filter(r=>r.network==='LG U+').length}</b></article>`;$('customerList').innerHTML=shown.length?shown.map(r=>{const due=dueInfo(r.activation_date),message=`${r.name} 고객님, 선불폰 요금 충전 예정일이 도래했습니다. 편하실 때 충전 부탁드립니다.`;return`<article class="customer-item"><button class="customer-main" data-edit="${esc(r.id)}"><b>${esc(r.name)} ${due?`<i class="due-pill ${due.alert?'alert':''}">${due.label}</i>`:''}</b><small>${esc(r.phone||'전화번호 없음')} · ${esc(r.network||'통신사 미지정')} ${esc(r.plan||'')}</small><small>${due?`충전예정 ${due.date}`:'개통일 미입력'} · ${r.owner_id===me.id?'내 고객':'공유 고객'}</small>${r.memo?`<span>${esc(r.memo)}</span>`:''}</button>${due?.alert&&r.phone?`<a class="customer-sms" href="sms:${encodeURIComponent(r.phone)}?&body=${encodeURIComponent(message)}">문자</a>`:''}${r.owner_id===me.id?`<button class="customer-delete" data-delete="${esc(r.id)}">삭제</button>`:''}</article>`}).join(''):'<p class="help">표시할 고객이 없습니다.</p>';root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>open(rows.find(r=>r.id===b.dataset.edit)));root.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete))};
  const enhanceCards=()=>root.querySelectorAll('.customer-item:not([data-enhanced])').forEach(card=>{card.dataset.enhanced='1';const id=card.querySelector('[data-edit]')?.dataset.edit,row=rows.find(item=>item.id===id);if(!row)return;const contract=contractInfo(row),main=card.querySelector('.customer-main');if(contract)main.insertAdjacentHTML('beforeend',`<small class="contract-pill ${contract.alert?'alert':''}">${contract.label} · ${contract.date}</small>`);card.insertAdjacentHTML('beforeend',`<button class="customer-vcard" type="button">📇</button>${row.owner_id===me.id?`<button class="customer-status ${row.status==='해지'?'stopped':''}" type="button">${row.status||'사용중'}</button>`:''}`);card.querySelector('.customer-vcard').onclick=()=>saveVcard(row);const status=card.querySelector('.customer-status');if(status)status.onclick=async()=>{const next=row.status==='해지'?'사용중':'해지',result=await supabase.from('customers').update({status:next,updated_at:new Date().toISOString()}).eq('id',row.id);if(result.error)$('customerError').textContent=result.error.message;else load()}});
  new MutationObserver(enhanceCards).observe($('customerList'),{childList:true});
  const syncChoices=()=>dialog.querySelectorAll('[data-choice]').forEach(group=>group.querySelectorAll('button').forEach(button=>button.classList.toggle('active',button.dataset.value===$(group.dataset.choice).value)));
  const todayStr=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
  const open=r=>{const edit=!r||r.owner_id===me.id;$('customerTitle').textContent=r?(edit?'고객 정보 수정':'공유 고객 상세'):'고객 등록';const values={cId:r?.id,cDate:r?.activation_date||(r?'':todayStr()),cMember:r?.member_no,cSeller:r?.seller,cName:r?.name,cPhone:r?.phone,cContactPhone:r?.contact_phone,cNetwork:r?.network,cPlan:r?.plan,cType:r?.activation_type||'신규',cSubscription:r?.subscription_type||'선불',cMethod:r?.activation_method||'플랫폼',cSource:r?.source||'메인블로그',cManager:r?.manager||(r?'':me.name),cContract:r?.contract_months||0,cProcess:r?.process_no,cMemo:r?.memo};Object.entries(values).forEach(([id,v])=>$(id).value=v||'');syncChoices();dialog.querySelectorAll('input,select,textarea').forEach(x=>x.disabled=!edit);dialog.querySelector('[type=submit]').hidden=!edit;dialog.querySelector(`[data-entry="${r?'direct':'paste'}"]`).click();dialog.showModal()};
  async function load(){const{data,error}=await supabase.from('customers').select('*').order('activation_date',{ascending:false,nullsFirst:false});if(error){$('customerError').textContent=friendlyError(error);return}rows=data||[];render()}
  async function remove(id){if(!confirm('고객 정보를 삭제할까요?'))return;const{error}=await supabase.from('customers').delete().eq('id',id);if(error)$('customerError').textContent=friendlyError(error);else load()}
  const applyParsed=p=>{$('cProcess').value=p.process_no;$('cName').value=p.name;$('cPhone').value=p.phone;$('cContactPhone').value=p.contact_phone;$('cNetwork').value=p.network;$('cPlan').value=p.plan;$('cType').value=p.activation_type;$('cSubscription').value=p.subscription_type;dialog.querySelector('[data-entry="direct"]').click()};
  const applyParsedVisit=p=>{
    $('cMethod').value='지점방문';
    if(p.network)$('cNetwork').value=p.network;
    if(p.subscription_type)$('cSubscription').value=p.subscription_type;
    if(p.activation_type)$('cType').value=p.activation_type;
    if(p.name)$('cName').value=p.name;
    if(p.plan)$('cPlan').value=p.plan;
    if(p.member_no)$('cMember').value=p.member_no;
    if(p.seller)$('cSeller').value=p.seller;
    $('cPhone').value='';
    const memoParts=[p.visit_time?`방문예약: ${p.visit_time}`:'',p.memo].filter(Boolean);
    if(memoParts.length)$('cMemo').value=[$('cMemo').value.trim(),...memoParts].filter(Boolean).join(' / ');
    syncChoices();
    dialog.querySelector('[data-entry="direct"]').click();
  };
  const importedRow=p=>({owner_id:me.id,activation_date:new Date().toISOString().slice(0,10),name:p.name||'이름 미상',phone:p.phone||null,contact_phone:p.contact_phone||null,network:p.network||null,plan:p.plan||null,activation_type:p.activation_type,subscription_type:p.subscription_type,activation_method:'플랫폼',source:'메인블로그',manager:me.name||null,process_no:p.process_no||null,status:'사용중'});
  dialog.querySelectorAll('[data-choice] button').forEach(button=>button.onclick=()=>{const group=button.closest('[data-choice]');$(group.dataset.choice).value=button.dataset.value;syncChoices()});
  const exportRows=()=>rows.filter(row=>scope==='mine'?row.owner_id===me.id:row.owner_id!==me.id);
  if(!viewOwner)$('cycleDays').onchange=()=>{rechargeCycleDays=Math.max(1,Number($('cycleDays').value||30));localStorage.setItem('nrc-recharge-cycle',String(rechargeCycleDays));render()};
  if(!viewOwner)$('exportVcf').onclick=()=>{const content=exportRows().map(row=>`BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${row.name||''}\r\nTEL;TYPE=CELL:${row.contact_phone||row.phone||''}\r\nNOTE:${[row.network,row.plan,row.memo].filter(Boolean).join(' / ').replace(/\n/g,' ')}\r\nEND:VCARD`).join('\r\n');download('NRC-고객연락처.vcf',content,'text/vcard;charset=utf-8')};
  if(!viewOwner)$('exportCsv').onclick=()=>{const fields=[['name','고객명'],['phone','개통번호'],['contact_phone','연락번호'],['member_no','회원번호'],['network','통신사'],['plan','요금제'],['activation_date','개통일'],['status','상태'],['manager','담당'],['memo','메모']],quote=value=>`"${String(value??'').replace(/"/g,'""')}"`,csv='\uFEFF'+[fields.map(x=>quote(x[1])).join(','),...exportRows().map(row=>fields.map(x=>quote(row[x[0]])).join(','))].join('\r\n');download('NRC-고객목록.csv',csv,'text/csv;charset=utf-8')};
  if(!viewOwner)$('exportJson').onclick=()=>download('NRC-고객백업.json',JSON.stringify({exported_at:new Date().toISOString(),customers:exportRows()},null,2),'application/json;charset=utf-8');
  if(!viewOwner){$('importJson').onclick=()=>$('importJsonFile').click();
  $('importJsonFile').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;const parsed=JSON.parse(await file.text()),source=Array.isArray(parsed)?parsed:parsed.customers;if(!Array.isArray(source))throw Error('고객 백업 JSON 형식이 아닙니다.');const keys=['activation_date','member_no','seller','name','phone','contact_phone','network','plan','activation_type','subscription_type','activation_method','source','manager','contract_months','process_no','status','last_reminder_sent_at','attribution','memo'],knownProcess=new Set(rows.map(row=>row.process_no).filter(Boolean)),knownPhone=new Set(rows.map(row=>String(row.phone||'').replace(/\D/g,'')).filter(Boolean));const restored=source.filter(row=>row?.name).filter(row=>!(row.process_no&&knownProcess.has(row.process_no))&&!knownPhone.has(String(row.phone||'').replace(/\D/g,''))).map(row=>Object.fromEntries([['owner_id',me.id],...keys.map(key=>[key,row[key]??null]),['updated_at',new Date().toISOString()]]));if(!restored.length)throw Error('새로 복원할 고객이 없습니다.');if(!confirm(`${restored.length}명을 기존 고객에 추가할까요?`))return;const{error}=await supabase.from('customers').insert(restored);if(error)throw error;$('customerError').textContent=`${restored.length}명을 복원했습니다.`;await load()}catch(error){$('customerError').textContent=error.message}finally{event.target.value=''}}};
  $('customerAdd').onclick=()=>open();$('customerClose').onclick=$('customerCancel').onclick=()=>dialog.close();$('customerSearch').oninput=$('customerNetwork').onchange=render;$('dueOnly').onclick=()=>{alertsOnly=!alertsOnly;$('dueOnly').classList.toggle('active',alertsOnly);render()};
  dialog.querySelectorAll('[data-entry]').forEach(b=>b.onclick=()=>{const mode=b.dataset.entry;dialog.querySelectorAll('[data-entry]').forEach(x=>x.classList.toggle('active',x===b));$('entryImport').hidden=mode==='direct';$('entryFile').hidden=!['backup','capture','visit'].includes(mode);$('entryText').hidden=['capture','visit'].includes(mode);$('entryParse').hidden=['capture','visit'].includes(mode);$('entryHint').textContent=mode==='backup'?'카톡 대화 내보내기 .txt에서 개통 메시지를 일괄 등록합니다.':mode==='capture'?'캡처본을 선택하면 OCR로 자동 인식합니다.':mode==='visit'?'센터방문 개통 요청서 이미지를 선택하면 OCR로 자동 인식합니다. 전화번호는 개통 완료 후 직접 입력해주세요.':'카톡 메시지를 그대로 붙여넣으면 자동으로 채웁니다.';if(['backup','capture','visit'].includes(mode))$('entryFile').click()});
  $('entryFile').onchange=async e=>{const file=e.target.files[0];if(!file)return;const mode=dialog.querySelector('[data-entry].active')?.dataset.entry;try{if(file.type.startsWith('image/')){$('entryHint').textContent='OCR 엔진 준비 중...';const onProgress=m=>{if(m.status==='recognizing text')$('entryHint').textContent=`텍스트 인식 중 ${Math.round((m.progress||0)*100)}%`};if(mode==='visit'){let fullText='',sellerBlockText='',rateBlockText='',source='cloud';try{$('entryHint').textContent='클라우드 OCR로 인식 중...';fullText=await cloudOcrVisitForm(file)}catch(cloudError){source='local';$('entryHint').textContent=`클라우드 OCR 실패(${cloudError.message}), 로컬 OCR로 재시도 중...`;const Tesseract=await loadOcr();({fullText,sellerBlockText,rateBlockText}=await ocrVisitForm(file,Tesseract,onProgress))}console.log(`[방문개통 OCR: ${source==='cloud'?'CLOVA OCR':'로컬 Tesseract'}]`,fullText,sellerBlockText,rateBlockText);applyParsedVisit(parseVisitForm(fullText,sellerBlockText,rateBlockText));return}const Tesseract=await loadOcr(),result=await Tesseract.recognize(file,'kor+eng',{logger:onProgress});applyParsed(parseActivation(result.data.text||''));return}const text=await file.text(),items=backupBlocks(text);if(!items.length)throw Error('개통 메시지를 찾지 못했습니다.');if(!confirm(`${items.length}건을 고객으로 일괄 등록할까요?`))return;const{error}=await supabase.from('customers').insert(items.map(importedRow));if(error)throw error;dialog.close();await load()}catch(error){$('entryHint').textContent=error.message}};
  $('entryParse').onclick=()=>applyParsed(parseActivation($('entryText').value));
  root.querySelectorAll('[data-scope]').forEach(b=>b.onclick=()=>{scope=b.dataset.scope;root.querySelectorAll('[data-scope]').forEach(x=>x.classList.toggle('active',x===b));render()});
  $('customerForm').onsubmit=async e=>{e.preventDefault();const id=$('cId').value,value={owner_id:me.id,activation_date:$('cDate').value||null,member_no:$('cMember').value||null,seller:$('cSeller').value||null,name:$('cName').value.trim(),phone:$('cPhone').value||null,contact_phone:$('cContactPhone').value||null,network:$('cNetwork').value||null,plan:$('cPlan').value||null,activation_type:$('cType').value,subscription_type:$('cSubscription').value,activation_method:$('cMethod').value,source:$('cSource').value||null,manager:$('cManager').value||null,contract_months:Number($('cContract').value||0),process_no:$('cProcess').value||null,memo:$('cMemo').value||null,updated_at:new Date().toISOString()};const{data:savedRow,error}=id?await supabase.from('customers').update(value).eq('id',id).select().single():await supabase.from('customers').insert(value).select().single();if(error)$('customerError').textContent=error.message;else{dialog.close();await load();if(!id){const picked=await askAmount('신규양도 금액 입력','새로 등록한 고객의 신규양도 금액을 입력하면 그 날짜의 활동 기록에 자동으로 더해집니다.',{presetCustomer:savedRow?{id:savedRow.id,name:savedRow.name}:null,date:value.activation_date});if(picked?.amount)await recordTransfer('new_transfer',picked.amount,picked.customer,picked.date)}}};
  $('transferAdd').onclick=async()=>{const picked=await askAmount('신규개통양도 입력','고객을 선택하고 금액·날짜를 입력하면 그 날짜의 활동 기록에 자동으로 더해집니다. 이전 자료를 입력할 땐 날짜를 바꿔주세요.',{needCustomer:true});if(picked?.amount)await recordTransfer('new_transfer',picked.amount,picked.customer,picked.date)};
  $('transferImport').onclick=()=>$('transferImportFile').click();
  $('transferTemplate').onclick=async()=>{
    const status=$('transferImportStatus');
    status.hidden=false;status.textContent='양식 만드는 중...';
    try{
      const XLSX=await loadXlsx();
      const sheet=XLSX.utils.aoa_to_sheet([
        ['날짜','구분','고객명','금액'],
        ['2026-08-01','신규개통양도','김철수',45000],
        ['2026-08-03','재구매양도','이영희',30000],
        ['2026-08-05','신규개통양도','',20000],
      ]);
      sheet['!cols']=[{wch:14},{wch:16},{wch:12},{wch:12}];
      const workbook=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook,sheet,'양도기록');
      XLSX.writeFile(workbook,'신규개통양도_양식.xlsx');
      status.hidden=true;
    }catch(error){
      status.textContent=friendlyError(error);
    }
  };
  $('transferImportFile').onchange=async event=>{
    const file=event.target.files[0],status=$('transferImportStatus');
    if(!file)return;
    status.hidden=false;status.textContent='파일 읽는 중...';
    try{
      const XLSX=await loadXlsx(),buffer=await file.arrayBuffer(),workbook=XLSX.read(buffer,{type:'array',cellDates:true}),sheet=workbook.Sheets[workbook.SheetNames[0]],grid=XLSX.utils.sheet_to_json(sheet,{header:1,raw:false,defval:''});
      if(!grid.length)throw Error('빈 파일입니다.');
      const headers=grid[0].map(h=>String(h||'').trim()),findCol=aliases=>headers.findIndex(h=>aliases.some(a=>h.toLowerCase().includes(a)));
      const dateCol=findCol(['날짜','일자','date']),fieldCol=findCol(['구분','종류','유형','type']),nameCol=findCol(['고객','이름','name']),amountCol=findCol(['금액','원','amount']);
      if(amountCol<0)throw Error('헤더에 "금액"이 들어간 열을 찾지 못했습니다. 예: 날짜, 구분, 고객명, 금액');
      const parsed=grid.slice(1).map(row=>{
        const amount=Number(String(row[amountCol]||'0').replace(/[^0-9.-]/g,''))||0;
        if(amount<=0)return null;
        const date=dateCol>=0?transferDateStr(row[dateCol]):'';
        return{date:date||localDate(),field:fieldCol>=0?transferFieldOf(row[fieldCol]):'new_transfer',customerName:nameCol>=0?(String(row[nameCol]||'').trim()||null):null,amount};
      }).filter(Boolean);
      if(!parsed.length)throw Error('가져올 유효한 행이 없습니다(금액이 0보다 커야 합니다).');
      const newCount=parsed.filter(p=>p.field==='new_transfer').length,repCount=parsed.length-newCount;
      if(!confirm(`${parsed.length}건을 가져올까요?\n신규개통양도 ${newCount}건 · 재구매양도 ${repCount}건`))return;
      status.textContent='저장하는 중...';
      await importTransferRows(parsed);
      status.textContent=`${parsed.length}건을 가져왔습니다.`;
      renderTransferList();
    }catch(error){
      status.textContent=friendlyError(error);
    }finally{
      event.target.value='';
    }
  };
  $('repurchaseAdd').onclick=()=>{$('repurchasePhone').value='';$('repurchaseMatches').innerHTML='';$('repurchaseAmountForm').hidden=true;repurchaseTarget=null;repurchaseDialog.showModal();$('repurchasePhone').focus()};
  $('repurchaseClose').onclick=()=>repurchaseDialog.close();
  const selectRepurchase=row=>{repurchaseTarget=row;$('repurchaseSelected').textContent=`${row.name} (${phone(row.phone)}) 고객`;$('repurchaseAmountForm').hidden=false;$('repurchaseValue').value='';$('repurchaseDate').value=localDate();$('repurchaseValue').focus()};
  $('repurchasePhone').oninput=()=>{
    const digits=$('repurchasePhone').value.replace(/\D/g,'');
    $('repurchaseAmountForm').hidden=true;repurchaseTarget=null;
    if(digits.length<2){$('repurchaseMatches').innerHTML='';return}
    const matches=rows.filter(r=>r.owner_id===me.id&&String(r.phone||'').replace(/\D/g,'').endsWith(digits));
    $('repurchaseMatches').innerHTML=matches.length?matches.map(r=>`<button type="button" class="repurchase-match" data-id="${esc(r.id)}">${esc(r.name)} <small>${esc(phone(r.phone))}</small></button>`).join(''):'<p class="help">일치하는 고객이 없습니다.</p>';
    $('repurchaseMatches').querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>selectRepurchase(rows.find(r=>r.id===b.dataset.id)))
  };
  $('repurchaseBack').onclick=()=>{$('repurchaseAmountForm').hidden=true;repurchaseTarget=null};
  $('repurchaseSkip').onclick=()=>{repurchaseTarget=null;$('repurchaseSelected').textContent='특정 고객 지정 없이 등록합니다.';$('repurchaseAmountForm').hidden=false;$('repurchaseValue').value='';$('repurchaseDate').value=localDate();$('repurchaseValue').focus()};
  $('repurchaseAmountForm').onsubmit=async e=>{e.preventDefault();const amount=Number($('repurchaseValue').value||0);if(amount>0)await recordTransfer('repurchase',amount,repurchaseTarget?{id:repurchaseTarget.id,name:repurchaseTarget.name}:null,$('repurchaseDate').value||localDate());repurchaseDialog.close()};
  await load();
  renderTransferList();
  if(options?.openAdd)open();
}
