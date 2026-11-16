// Jidon PBZ loader. Authored from documented Windows APIs and observed game ABI.
// No network, registry, shell execution, mod enumeration or external downloads.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <stdint.h>
#include <string>
#include <vector>
#include <cstring>
#include "generated.h"
#pragma comment(lib,"bcrypt.lib")
extern "C" { void* hid_targets[47] = {}; }
static INIT_ONCE systemOnce=INIT_ONCE_STATIC_INIT;
static HANDLE logFile=INVALID_HANDLE_VALUE;
static uintptr_t image;
static volatile LONG installed=0,started=0,sourceAccepted=0;
struct FString { wchar_t* data; int32_t num,cap; };
struct Bytes { unsigned char* data; int32_t num,cap; };
using Validate=bool(*)(FString*,void*);
using Start=void(*)(void*,FString*,void*);
static Validate originalBytes,originalSource;
static Start originalStart;
static void log(const char* s) {
 if(logFile==INVALID_HANDLE_VALUE)return; DWORD n;
 WriteFile(logFile,s,(DWORD)strlen(s),&n,nullptr);WriteFile(logFile,"\r\n",2,&n,nullptr);FlushFileBuffers(logFile);
}
static BOOL CALLBACK resolveSystem(PINIT_ONCE,void*,void**) {
 wchar_t path[MAX_PATH];UINT n=GetSystemDirectoryW(path,MAX_PATH);
 if(!n||n>MAX_PATH-10)return FALSE;
 wcscat_s(path,L"\\hid.dll");HMODULE lib=LoadLibraryExW(path,nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
 if(!lib)return FALSE;
 for(int i=0;i<47;i++){hid_targets[i]=(void*)GetProcAddress(lib,kExports[i]);if(!hid_targets[i])return FALSE;}
 return TRUE;
}
extern "C" void resolve_hid() {
 if(!InitOnceExecuteOnce(&systemOnce,resolveSystem,nullptr,nullptr)) RaiseFailFastException(nullptr,nullptr,0);
}
static bool good(FString* s) {return s&&s->data&&s->num>0&&s->num<4096&&s->cap>=s->num&&s->data[s->num-1]==0;}
static bool owned(FString* s) {
 if(!good(s))return false;
 std::wstring name(s->data,s->num-1);for(auto& c:name){if(c==L'\\')c=L'/';}
 const std::wstring suffix=L"JidonPBZ/boot.js";
 return name==suffix || (name.size()>suffix.size() && name.compare(name.size()-suffix.size(),suffix.size(),suffix)==0 && name[name.size()-suffix.size()-1]==L'/');
}
static bool bytesHook(FString* name,void* v) {
 if(!owned(name))return originalBytes(name,v);
 Bytes* b=(Bytes*)v;
 bool ok=b&&b->num==(int)sizeof(kScript)-1&&b->cap>=b->num&&b->data&&!memcmp(b->data,kScript,b->num);
 log(ok?"script bytes accepted":"script bytes REJECTED");return ok;
}
static bool sourceHook(FString* name,void* v) {
 if(!owned(name))return originalSource(name,v);
 FString* s=(FString*)v;bool ok=false;
 // Puerts wraps CommonJS source with 62 UTF-16 prefix characters and 4 suffix characters.
 if(s&&s->data&&s->cap>=s->num&&s->num==(int)sizeof(kScript)+66) {
  const wchar_t prefix[]=L"(function (exports, require, module, __filename, __dirname) { ";
  ok=!wmemcmp(s->data,prefix,62) && !wmemcmp(s->data+s->num-5,L"\n});",4) && s->data[s->num-1]==0;
  for(size_t i=0;ok && i<sizeof(kScript)-1;i++)if(s->data[62+i]!=(unsigned char)kScript[i])ok=false;
 }
 if(ok)InterlockedExchange(&sourceAccepted,1);
 log(ok?"script source accepted":"script source REJECTED");return ok;
}
static void startHook(void* env,FString* module,void* args) {
 if(InterlockedCompareExchange(&installed,0,0) && good(module) && wcscmp(module->data,L"MainStart")==0 && InterlockedCompareExchange(&started,1,0)==0) {
  static wchar_t text[]=L"JidonPBZ/boot";FString own{text,(int)_countof(text),(int)_countof(text)};
  log("starting owned bootstrap");originalStart(env,&own,args);log("bootstrap Start returned");
  if(!InterlockedCompareExchange(&sourceAccepted,0,0)){log("owned source rejected; falling back to original MainStart");originalStart(env,module,args);}
 } else originalStart(env,module,args);
}
static bool fileHash(const wchar_t* path) {
 HANDLE f=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
 if(f==INVALID_HANDLE_VALUE)return false;
 BCRYPT_ALG_HANDLE alg=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;unsigned char digest[32];bool ok=false;
 if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)goto done;
 if(BCryptCreateHash(alg,&hash,nullptr,0,nullptr,0,0)<0)goto done;
 {unsigned char buffer[65536];DWORD n;for(;;){if(!ReadFile(f,buffer,sizeof(buffer),&n,nullptr))goto done;if(!n)break;if(BCryptHashData(hash,buffer,n,0)<0)goto done;}}
 if(BCryptFinishHash(hash,digest,32,0)>=0)ok=!memcmp(digest,kGameHash,32);
 done:if(hash)BCryptDestroyHash(hash);if(alg)BCryptCloseAlgorithmProvider(alg,0);CloseHandle(f);return ok;
}
struct Patch {volatile LONG64* address;LONG64 before,after;};
static bool scriptMatches(const std::wstring& directory) {
 std::wstring path=directory+L"..\\..\\ProjectPBZ\\Content\\JavaScript\\JidonPBZ\\boot.js";
 HANDLE f=CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
 if(f==INVALID_HANDLE_VALUE)return false;
 LARGE_INTEGER size;bool ok=GetFileSizeEx(f,&size)&&size.QuadPart==sizeof(kScript)-1;
 if(ok){std::vector<char> data((size_t)size.QuadPart);DWORD n=0;ok=ReadFile(f,data.data(),(DWORD)data.size(),&n,nullptr)&&n==data.size()&&!memcmp(data.data(),kScript,data.size());}
 CloseHandle(f);return ok;
}
static bool swap(Patch& p,bool undo=false) {
 DWORD prior;if(!VirtualProtect((void*)p.address,8,PAGE_EXECUTE_READWRITE,&prior))return false;
 LONG64 a=undo?p.after:p.before,b=undo?p.before:p.after;
 bool ok=InterlockedCompareExchange64(p.address,b,a)==a;
 DWORD ignored;bool restored=VirtualProtect((void*)p.address,8,prior,&ignored)!=0;
 FlushInstructionCache(GetCurrentProcess(),(void*)p.address,8);return ok&&restored;
}
static DWORD WINAPI worker(void*) {
 wchar_t exe[32768];if(!GetModuleFileNameW(nullptr,exe,_countof(exe)))return 0;
 wchar_t* filename=wcsrchr(exe,L'\\');if(!filename||_wcsicmp(filename+1,L"PBZ.exe"))return 0;
 std::wstring logfile(exe,filename+1);logfile+=L"JidonPBZ-native.log";
 logFile=CreateFileW(logfile.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
 log("JidonPBZ source-built loader v0.1");
 resolve_hid();
 if(!fileHash(exe)){log("unsupported game SHA256; no hooks installed");return 0;}
 if(!scriptMatches(std::wstring(exe,filename+1))){log("owned script missing or modified; no hooks installed");return 0;}
 image=(uintptr_t)GetModuleHandleW(nullptr);
 auto nt=(IMAGE_NT_HEADERS64*)(image+((IMAGE_DOS_HEADER*)image)->e_lfanew);
 if(nt->OptionalHeader.SizeOfImage!=kImageSize||nt->FileHeader.TimeDateStamp!=kTimestamp){log("PE mismatch");return 0;}
 // Give the game bootstrap a bounded interval to restore its original instruction bytes.
 bool ready=false;for(int attempt=0;attempt<200;attempt++){
  ready=true;for(auto& c:kCalls)if(memcmp((void*)(image+c.rva),c.expected,8)){ready=false;break;}
  if(ready)break;Sleep(25);
 }
 if(!ready){log("call-site bytes mismatch; no hooks installed");return 0;}
 originalBytes=(Validate)(image+kCalls[0].target);originalSource=(Validate)(image+kCalls[4].target);originalStart=(Start)(image+kCalls[5].target);
 unsigned char* thunks=nullptr;
 for(uintptr_t p=(image+nt->OptionalHeader.SizeOfImage+65535)&~uintptr_t(65535);p<image+0x70000000;p+=65536){
  thunks=(unsigned char*)VirtualAlloc((void*)p,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);if(thunks)break;
 }
 // The upper range may already be reserved by the game on a later launch.
 // Scan the lower range too; all call sites still remain within signed rel32 reach.
 if(!thunks)for(uintptr_t gap=65536;gap<0x70000000 && image>gap+65536;gap+=65536){
  uintptr_t p=(image-gap)&~uintptr_t(65535);
  thunks=(unsigned char*)VirtualAlloc((void*)p,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);if(thunks)break;
 }
 if(!thunks){log("no near memory; no hooks installed");return 0;}
 void* targets[]={(void*)bytesHook,(void*)sourceHook,(void*)startHook};
 for(int i=0;i<3;i++){auto t=thunks+i*16;t[0]=0x48;t[1]=0xb8;memcpy(t+2,&targets[i],8);t[10]=0xff;t[11]=0xe0;}
 DWORD old;if(!VirtualProtect(thunks,4096,PAGE_EXECUTE_READ,&old)){log("RX protection failed");return 0;}
 FlushInstructionCache(GetCurrentProcess(),thunks,4096);
 Patch patches[6]{};
 for(int i=0;i<6;i++){
  uintptr_t site=image+kCalls[i].rva,word=(site+1)&~uintptr_t(7);int offset=(int)(site+1-word);
  if(offset+4>8){log("unaligned patch contract");return 0;}
  patches[i].address=(volatile LONG64*)word;patches[i].before=*(LONG64*)word;patches[i].after=patches[i].before;
  int64_t distance=(uintptr_t)(thunks+(i<4?0:i==4?16:32))-(site+5);
  if(distance>INT32_MAX||distance<INT32_MIN)return 0;
  int32_t delta=(int32_t)distance;memcpy((char*)&patches[i].after+offset,&delta,4);
 }
 for(int i=0;i<6;i++)if(!swap(patches[i])){for(int j=i;j>=0;j--)swap(patches[j],true);log("hook failed; rollback attempted");return 0;}
 InterlockedExchange(&installed,1);log("six verified calls installed; only JidonPBZ/boot.js is additionally authorized");return 0;
}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID) {
 if(reason==DLL_PROCESS_ATTACH){DisableThreadLibraryCalls(instance);HANDLE t=CreateThread(nullptr,0,worker,nullptr,0,nullptr);if(t)CloseHandle(t);}
 return TRUE;
}
