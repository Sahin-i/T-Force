import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** Readers see either the previous complete report or the next complete report. */
export async function atomicReport(filename:string,value:unknown):Promise<void>{
  const temporary=`${filename}.${randomUUID()}.tmp`;try{await writeFile(temporary,JSON.stringify(value,null,2),{flag:'wx'});await rename(temporary,filename);}finally{await unlink(temporary).catch(()=>{});}
}
