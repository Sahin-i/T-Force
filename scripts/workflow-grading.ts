import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';

export function unwrapEvidence(value:unknown):unknown{
  for(let depth=0;depth<10&&value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'value');depth++)value=(value as {value:unknown}).value;
  return value;
}
function normalizedKey(key:string){return key.toLowerCase().replace(/[\s_-]/g,'');}
const aliases:Record<string,string[]>={po_number:['purchaseOrder','purchaseOrderNumber'],invoice_number:['invoiceNo'],authority:['powerOfAttorney','authorization'],extract:['companyExtract','registrationExtract'],identification:['representativeIdentification','identityDocument']};
export function semanticField(root:unknown,path:string):unknown{
  let current=unwrapEvidence(root);
  for(const key of path.split('.')){
    if(!current||typeof current!=='object'||Array.isArray(current))return undefined;
    const wanted=[key,...(aliases[key]??[])].map(normalizedKey);const entry=Object.entries(current).find(([name])=>wanted.includes(normalizedKey(name)));
    current=unwrapEvidence(entry?.[1]);
  }
  return current;
}
export function extractedFacts(result:Record<string,unknown>):Record<string,unknown>{
  for(const key of ['extracted','extractedFields','extraction','extractedData','documentData','documents','invoice','invoiceFields','invoiceData','extractedInvoice','complaint','complaintFields','complaintData']){
    const value=unwrapEvidence(result[key]);if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>;
  }
  return result;
}

/** Exact finite decimal comparison; accepts numeric representation differences. */
export function decimalValue(value:unknown):string|undefined{
  value=unwrapEvidence(value);
  if(typeof value==='number'&&!Number.isFinite(value)||!['string','number'].includes(typeof value))return undefined;
  const raw=String(value).trim().replace(',','.');if(raw.length>256)return undefined;
  const match=/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(raw);if(!match||!`${match[2]}${match[3]??''}`.length)return undefined;
  let digits=`${match[2]}${match[3]??''}`.replace(/^0+/,'');let exponent=Number(match[4]??0)-(match[3]?.length??0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>10000)return undefined;
  if(!digits)return '0';while(digits.endsWith('0')){digits=digits.slice(0,-1);exponent++;}
  return `${match[1]==='-'?'-':''}${digits}e${exponent}`;
}
export function factsEqual(key:string,expected:unknown,actual:unknown):boolean{
  actual=unwrapEvidence(actual);const leaf=key.split('.').at(-1)!;
  if(['quantity','unit_price','total','amount','calculatedTotal','creditRecommendation','chargedTotal'].includes(leaf))return decimalValue(expected)!==undefined&&decimalValue(expected)===decimalValue(actual);
  if(typeof expected==='string')return actual!==undefined&&String(actual).normalize('NFKC').trim().replace(/\s+/g,' ')===expected.normalize('NFKC').trim().replace(/\s+/g,' ');
  return JSON.stringify(expected)===JSON.stringify(actual);
}
export function calculatedField(result:Record<string,unknown>,key:string):unknown{
  const direct=semanticField(result,key);if(direct!==undefined)return direct;
  const facts=semanticField(extractedFacts(result),key);if(facts!==undefined)return facts;
  for(const container of ['calculations','calculation','totals','reconciliation','validation']){const value=semanticField(result[container],key);if(value!==undefined)return value;}
  if(key==='creditRecommendation')return semanticField(result.queueRecord,'creditAmount');
  return undefined;
}

interface XmlNode {name:string;attributes:Record<string,string>;text:string;children:XmlNode[]}
function parseXml(bytes:Uint8Array):XmlNode{
  const parser=new SaxesParser({xmlns:true});const stack:XmlNode[]=[];let root:XmlNode|undefined;
  parser.on('opentag',tag=>{const node:XmlNode={name:tag.local,attributes:Object.fromEntries(Object.values(tag.attributes).map(attribute=>[attribute.local,attribute.value])),text:'',children:[]};if(stack.length)stack.at(-1)!.children.push(node);else root=node;stack.push(node);});
  parser.on('text',text=>{if(stack.length)stack.at(-1)!.text+=text;});parser.on('closetag',()=>{stack.pop();});parser.write(strFromU8(bytes)).close();if(!root)throw new Error('Missing XML root');return root;
}
function descendants(node:XmlNode,name:string):XmlNode[]{return [...(node.name===name?[node]:[]),...node.children.flatMap(child=>descendants(child,name))];}
function textContent(node:XmlNode):string{return node.text+node.children.map(textContent).join('');}
function columnName(number:number):string{let value='';for(;number;number=Math.floor((number-1)/26))value=String.fromCharCode(65+(number-1)%26)+value;return value;}
export interface PlainSheet {rowCount:number;getCell:(address:string)=>{value:unknown};getRows:(start:number,count:number)=>{getCell:(column:number)=>{value:unknown}}[]}

/** Independent OOXML cell reader; comments/styles cannot hide business values. */
export function readXlsxCells(bytes:Buffer):PlainSheet{
  const parts=unzipSync(bytes);for(const part of ['[Content_Types].xml','_rels/.rels','xl/workbook.xml','xl/_rels/workbook.xml.rels'])if(!parts[part])throw new Error(`Missing XLSX part ${part}`);
  const workbook=parseXml(parts['xl/workbook.xml']!);const sheet=descendants(workbook,'sheet')[0];if(!sheet)throw new Error('Workbook has no sheets');
  const relations=parseXml(parts['xl/_rels/workbook.xml.rels']!);const relation=descendants(relations,'Relationship').find(node=>node.attributes.Id===sheet.attributes.id);if(!relation)throw new Error('Worksheet relationship is missing');
  const target=relation.attributes.Target;const filename=target.startsWith('/')?target.slice(1):`xl/${target}`;if(filename.includes('..')||!parts[filename])throw new Error('Worksheet target is invalid or absent');
  const shared=parts['xl/sharedStrings.xml']?descendants(parseXml(parts['xl/sharedStrings.xml']!),'si').map(textContent):[];
  const cells=new Map<string,unknown>();let rowCount=0;
  for(const row of descendants(parseXml(parts[filename]!),'row')){
    const number=Number(row.attributes.r);if(!Number.isInteger(number)||number<1)throw new Error('Invalid worksheet row');rowCount=Math.max(rowCount,number);
    for(const cell of row.children.filter(node=>node.name==='c')){
      const address=cell.attributes.r;if(!/^[A-Z]+\d+$/.test(address))throw new Error('Invalid worksheet cell reference');
      const raw=cell.children.find(node=>node.name==='v')?.text;const type=cell.attributes.t;
      const value=type==='inlineStr'?cell.children.filter(node=>node.name==='is').map(textContent).join(''):type==='s'?shared[Number(raw)]:type==='b'?raw==='1':type==='str'?raw:raw!==undefined?Number(raw):undefined;
      if(type==='s'&&value===undefined)throw new Error('Invalid shared-string index');if(raw!==undefined&&!type&&!Number.isFinite(value))throw new Error('Invalid numeric worksheet value');
      cells.set(address,value);
    }
  }
  return {rowCount,getCell:address=>({value:cells.get(address)}),getRows:(start,count)=>Array.from({length:count},(_,i)=>({getCell:column=>({value:cells.get(`${columnName(column)}${start+i}`)})}))};
}
