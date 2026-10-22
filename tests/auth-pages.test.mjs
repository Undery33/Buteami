import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {formFields} from '../assets/auth-validation.js';
const root=new URL('../',import.meta.url),pages=['login','find-id','reset-password','signup'];
test('all account pages resolve their local assets and navigation targets',()=>{
 for(const page of pages){const file=new URL(`auth/${page}.html`,root),html=readFileSync(file,'utf8');for(const[,ref]of html.matchAll(/(?:src|href)="([^"]+)"/g)){if(/^(?:https?:|#)/.test(ref))continue;assert.ok(existsSync(new URL(ref,file)),`${page}: missing ${ref}`);}}
});
test('account forms fail closed without JS and do not use native submission',()=>{
 for(const page of pages){const html=readFileSync(new URL(`auth/${page}.html`,root),'utf8');assert.match(html,/<fieldset disabled>/);assert.match(html,/form-action 'none'/);assert.match(html,/<noscript\b[^>]*>/);assert.match(html,/id="form-summary" role="alert" tabindex="-1"/);assert.match(html,/id="result-title"/);assert.doesNotMatch(html,/UI PREVIEW|DB 연결 전|인증 코드|인증된 계정|이메일 인증|data-form-kind/);for(const[input]of html.matchAll(/<input\b[^>]*>/g))assert.doesNotMatch(input,/\bname=/);const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size,`${page}: duplicate IDs`);for(const[,kind]of html.matchAll(/data-form="([^"]+)"/g))for(const key of formFields[kind])assert.ok(ids.includes(key),`${page}: missing ${key}`);}
});
test('signup collects birthday and recovery uses account details without email verification',()=>{
 for(const page of ['signup','reset-password']){const html=readFileSync(new URL(`auth/${page}.html`,root),'utf8');assert.match(html,/6~128/);for(const[input]of html.matchAll(/<input\b[^>]*type="password"[^>]*>/g))assert.match(input,/minlength="6"/);assert.doesNotMatch(html,/12~128|minlength="12"|id="token"/);}
 assert.match(readFileSync(new URL('auth/signup.html',root),'utf8'),/id="birthday" type="date"/);
 assert.match(readFileSync(new URL('auth/reset-password.html',root),'utf8'),/id="fullName"/);
 assert.match(readFileSync(new URL('auth/login.html',root),'utf8'),/id="logout"/);
 assert.equal(existsSync(new URL('auth/verify-email.html',root)),false);
 assert.deepEqual(formFields['reset-password'],['fullName','username','email','password','confirmPassword']);
});
