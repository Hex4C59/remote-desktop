#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include "windivert.h"
#include "scheduler.h"
#include <array>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <regex>
#include <sstream>
#include <thread>
#include <vector>

using impairment::Mode;
namespace fs=std::filesystem;
static std::int64_t QpcNs(std::int64_t ticks) {
  LARGE_INTEGER f{}; QueryPerformanceFrequency(&f);
  return (ticks/f.QuadPart)*1000000000LL + (ticks%f.QuadPart)*1000000000LL/f.QuadPart;
}
static std::int64_t Now() {
  LARGE_INTEGER n{}; QueryPerformanceCounter(&n); return QpcNs(n.QuadPart);
}
static std::string Read(const fs::path& path) {
  std::ifstream file(path); std::string s; std::getline(file,s); return s;
}
static void Write(const fs::path& path, const std::string& text) {
  std::ofstream file(path,std::ios::trunc); file << text << '\n'; file.flush();
  if(!file) throw std::runtime_error("Cannot write control receipt");
}
static std::string Quote(const std::string& s) {
  std::string out="\"";
  for(char c:s) { if(c=='\\'||c=='\"') out+='\\'; if(static_cast<unsigned char>(c)<32) throw std::runtime_error("Control character"); out+=c; }
  return out+'\"';
}
static std::map<std::string,std::string> Arguments(int argc,char**argv) {
  std::map<std::string,std::string> args;
  for(int i=1;i<argc;i+=2) {
    if(i+1==argc || std::string(argv[i]).find("--")!=0 || !args.emplace(argv[i]+2,argv[i+1]).second)
      throw std::runtime_error("Expected unique --key value arguments");
  }
  return args;
}
static std::string Need(const std::map<std::string,std::string>& a,const std::string& k) {
  auto i=a.find(k); if(i==a.end()||i->second.empty()) throw std::runtime_error("Missing argument: "+k); return i->second;
}
static unsigned Port(const std::string& s) {
  if(!std::regex_match(s,std::regex("[0-9]{1,5}"))) throw std::runtime_error("Invalid port");
  auto p=std::stoul(s); if(!p||p>65535)throw std::runtime_error("Invalid port"); return static_cast<unsigned>(p);
}
static Mode Profile(const std::string& s) {
  if(s=="pass")return Mode::Pass; if(s=="rate")return Mode::Rate;
  if(s=="delay")return Mode::Delay; if(s=="loss")return Mode::Loss;
  throw std::runtime_error("Unknown single-factor profile");
}
struct Packet {std::vector<unsigned char> bytes; WINDIVERT_ADDRESS address{}; std::uint64_t id; std::int64_t captured,due; unsigned direction; std::string epoch="0";};
class Trace {
 public:
  Trace(const fs::path& directory,std::string experiment,std::string session)
      : file_(directory/"trace.jsonl"), experiment_(std::move(experiment)),session_(std::move(session)) {
    if(!file_) throw std::runtime_error("Cannot create trace");
  }
  void Event(const std::string& event,const std::string& fields="") {
    std::lock_guard lock(mutex_);
    file_ << "{\"schema\":\"network-shaper-trace-v1\",\"experiment\":"<<Quote(experiment_)
      <<",\"session\":"<<Quote(session_)<<",\"clock\":\"QueryPerformanceCounter_ns\",\"event\":"<<Quote(event)
      <<",\"observed_ns\":\""<<Now()<<"\""<<fields<<"}\n";
    file_.flush(); if(!file_) throw std::runtime_error("Trace write failed");
  }
  void PacketEvent(const Packet& p,const std::string& result) {
    Event("packet",",\"packet_id\":"+std::to_string(p.id)+",\"direction\":"+Quote(p.direction?"up":"down")+
      ",\"epoch\":"+Quote(p.epoch)+",\"bytes\":"+std::to_string(p.bytes.size())+",\"captured_ns\":\""+std::to_string(p.captured)+
      "\",\"due_ns\":\""+std::to_string(p.due)+"\",\"result\":"+Quote(result));
  }
 private:
  std::mutex mutex_; std::ofstream file_; std::string experiment_,session_;
};
// Separate process holds an inherited handle to exactly this process, avoiding PID reuse.
static int Watchdog(const std::map<std::string,std::string>& args) {
  HANDLE parent=reinterpret_cast<HANDLE>(static_cast<uintptr_t>(std::stoull(Need(args,"watchdog-handle"))));
  fs::path root=Need(args,"directory");
  auto last=Read(root/"heartbeat.txt"); auto changed=Now(); std::int64_t active=0;
  while(WaitForSingleObject(parent,100)==WAIT_TIMEOUT) {
    auto now=Now(); auto beat=Read(root/"heartbeat.txt");
    if(beat!=last && !beat.empty()) {last=beat;changed=now;}
    bool enabled=Read(root/"active.txt")=="active";
    if(enabled && !active)active=now; if(!enabled)active=0;
    std::string reason;
    if(now-changed>=5000000000LL)reason="heartbeat_lost";
    if(active && now-active>=150000000000LL)reason="active_deadline";
    if(!reason.empty()) {
      Write(root/"watchdog.json","{\"schema\":\"shaper-watchdog-v1\",\"reason\":"+Quote(reason)+",\"observed_ns\":\""+std::to_string(now)+"\"}");
      if(!TerminateProcess(parent,90)) {CloseHandle(parent);return 2;}
      WaitForSingleObject(parent,5000); CloseHandle(parent); return 0;
    }
  }
  CloseHandle(parent); return 0;
}
static std::string CommandArgument(const std::string& value) {
  std::string out="\"";
  std::size_t slashes=0;
  for(char c:value) {
    if(c=='\\') {++slashes;continue;}
    if(c=='\"')out.append(slashes*2+1,'\\'); else out.append(slashes,'\\');
    slashes=0;out+=c;
  }
  out.append(slashes*2,'\\');return out+'\"';
}
static HANDLE StartWatchdog(const fs::path& directory) {
  HANDLE own=OpenProcess(SYNCHRONIZE|PROCESS_TERMINATE,TRUE,GetCurrentProcessId());
  if(!own)throw std::runtime_error("Cannot open own watchdog process handle");
  char exe[32768]{}; if(!GetModuleFileNameA(nullptr,exe,sizeof(exe)))throw std::runtime_error("Cannot locate executable");
  std::string command=CommandArgument(exe)+" --watchdog-handle "+std::to_string(reinterpret_cast<uintptr_t>(own))+" --directory "+CommandArgument(directory.string());
  STARTUPINFOA si{};si.cb=sizeof(si);PROCESS_INFORMATION pi{};
  BOOL ok=CreateProcessA(exe,command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW,nullptr,nullptr,&si,&pi);
  CloseHandle(own);
  if(!ok)throw std::runtime_error("Cannot launch independent watchdog");
  CloseHandle(pi.hThread);return pi.hProcess;
}
int main(int argc,char**argv) {
  HANDLE handle=INVALID_HANDLE_VALUE,watchdog=nullptr;
  std::thread receiver;
  std::atomic<bool> stopping=false;
  try {
    auto args=Arguments(argc,argv);
    if(args.contains("watchdog-handle"))return Watchdog(args);
    const std::array<std::string,8> allowed={"local-address","remote-address","local-port","remote-port","session","experiment","directory","profile"};
    if(args.size()!=allowed.size())throw std::runtime_error("Unexpected/missing configuration");
    for(const auto& key:allowed)Need(args,key);
    auto local=Need(args,"local-address"),remote=Need(args,"remote-address");
    IN_ADDR local_ip{},remote_ip{};
    if(InetPtonA(AF_INET,local.c_str(),&local_ip)!=1||InetPtonA(AF_INET,remote.c_str(),&remote_ip)!=1)throw std::runtime_error("Expected verified IPv4 endpoints");
    auto lp=Port(Need(args,"local-port")),rp=Port(Need(args,"remote-port"));
    std::regex uuid("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    auto experiment=Need(args,"experiment"),session=Need(args,"session");
    if(!std::regex_match(experiment,uuid)||!std::regex_match(session,uuid))throw std::runtime_error("Invalid identity");
    const auto configured=Need(args,"profile"); Profile(configured);
    const auto root=fs::absolute(Need(args,"directory"));
    if(!fs::is_directory(root)||fs::exists(root/"trace.jsonl")||Read(root/"heartbeat.txt").empty())throw std::runtime_error("Fresh owned directory and live heartbeat required");
    Trace trace(root,experiment,session);
    std::string filter="udp and ((ip.SrcAddr == "+local+" and ip.DstAddr == "+remote+" and udp.SrcPort == "+std::to_string(lp)+" and udp.DstPort == "+std::to_string(rp)+") or (ip.SrcAddr == "+remote+" and ip.DstAddr == "+local+" and udp.SrcPort == "+std::to_string(rp)+" and udp.DstPort == "+std::to_string(lp)+"))";
    Write(root/"active.txt","pass");
    watchdog=StartWatchdog(root);
    handle=WinDivertOpen(filter.c_str(),WINDIVERT_LAYER_NETWORK,0,0);
    if(handle==INVALID_HANDLE_VALUE)throw std::runtime_error("WinDivertOpen failed: "+std::to_string(GetLastError()));
    trace.Event("started",",\"filter\":"+Quote(filter)+",\"configured_profile\":"+Quote(configured)+",\"rate_bps\":116093,\"delay_ns\":\"50000000\",\"loss_probability\":0.01,\"loss_seed\":20261013,\"random_algorithm\":\"xorshift64star-v1\",\"queue_max_bytes_per_direction\":1048576,\"queue_max_ns\":\"2000000000\",\"pid\":"+std::to_string(GetCurrentProcessId()));
    struct Timer {
      HANDLE value=CreateWaitableTimerExW(nullptr,nullptr,CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,TIMER_ALL_ACCESS);
      ~Timer(){if(value)CloseHandle(value);}
    } timer;
    if(!timer.value)throw std::runtime_error("High resolution waitable timer unavailable");
    std::array<std::int64_t,2> next_injection{};
    std::string admitted_epoch="0";
    std::uint64_t last_epoch=0;
    std::mutex queue_mutex;
    std::array<std::deque<Packet>,2> queues;
    std::array<impairment::Scheduler,2> schedulers={impairment::Scheduler(0),impairment::Scheduler(1)};
    std::atomic<bool> receive_failed=false;
    struct ReceiverCleanup {
      HANDLE& handle; std::thread& reader; std::atomic<bool>& stopping;
      ~ReceiverCleanup() {
        stopping=true;
        if(handle!=INVALID_HANDLE_VALUE)WinDivertShutdown(handle,WINDIVERT_SHUTDOWN_RECV);
        if(reader.joinable())reader.join();
        if(handle!=INVALID_HANDLE_VALUE){WinDivertClose(handle);handle=INVALID_HANDLE_VALUE;}
      }
    } cleanup{handle,receiver,stopping};
    receiver=std::thread([&] {
      try {
        std::uint64_t id=0;
        for(;;) {
          Packet p; p.bytes.resize(65535);UINT length=0;
          if(!WinDivertRecv(handle,p.bytes.data(),static_cast<UINT>(p.bytes.size()),&length,&p.address)) {
            if(!stopping)receive_failed=true;break;
          }
          p.bytes.resize(length);p.id=++id;p.captured=QpcNs(p.address.Timestamp);
          PWINDIVERT_IPHDR ip=nullptr;PWINDIVERT_UDPHDR udp=nullptr;
          if(!WinDivertHelperParsePacket(p.bytes.data(),length,&ip,nullptr,nullptr,nullptr,nullptr,nullptr,&udp,nullptr,nullptr,nullptr,nullptr)||!ip||!udp)throw std::runtime_error("Unexpected packet in verified UDP filter");
          p.direction=(ip->SrcAddr==local_ip.S_un.S_addr && udp->SrcPort==htons(static_cast<u_short>(lp)))?0:1;
          std::lock_guard lock(queue_mutex);
          p.epoch=admitted_epoch;
          auto decision=schedulers[p.direction].Enqueue(p.captured,length);p.due=decision.due_ns;
          if(stopping) {WinDivertSend(handle,p.bytes.data(),length,nullptr,&p.address);trace.PacketEvent(p,"shutdown_forward");schedulers[p.direction].Complete(decision.result==impairment::Result::Queued?length:0);continue;}
          if(decision.result!=impairment::Result::Queued)trace.PacketEvent(p,decision.result==impairment::Result::RandomDrop?"random_drop":"queue_drop");
          else queues[p.direction].push_back(std::move(p));
        }
      } catch(...) {receive_failed=true;}
    });
    Write(root/"ready.json","{\"session\":"+Quote(session)+",\"experiment\":"+Quote(experiment)+",\"pid\":"+std::to_string(GetCurrentProcessId())+"}");
    std::string control="",current="pass";std::int64_t next_control=0;
    while(!receive_failed) {
      auto now=Now();
      if(now>=next_control) {
        auto requested=Read(root/"control.txt");next_control=now+20000000;
        if(!requested.empty() && requested!=control) {
          std::istringstream input(requested);std::string owner,epoch,mode,extra; input>>owner>>epoch>>mode;
          if(owner!=session||epoch.empty()||input>>extra||(mode!="pass"&&mode!="active"&&mode!="stop"))throw std::runtime_error("Invalid scoped control command");
          if(!std::regex_match(epoch,std::regex("[0-9]{1,18}")) || std::stoull(epoch)<=last_epoch)
            throw std::runtime_error("Stale control epoch");
          last_epoch=std::stoull(epoch);
          if(mode=="stop"){control=requested;break;}
          {
            std::lock_guard lock(queue_mutex);
            for(unsigned d=0;d<2;++d) {
              for(const auto& p:queues[d])trace.PacketEvent(p,"clear_drop");
              queues[d].clear();next_injection[d]=0;schedulers[d].Reset(mode=="active"?Profile(configured):Mode::Pass);
            }
            admitted_epoch=epoch;
            current=mode=="active"?configured:"pass";
            Write(root/"active.txt",mode);
            trace.Event("profile_applied",",\"profile\":"+Quote(current)+",\"epoch\":"+Quote(epoch));
          }
          Write(root/"applied.txt",requested);control=requested;
        }
      }
      std::unique_lock lock(queue_mutex);
      for(unsigned d=0;d<2;++d) {
        while(!queues[d].empty()&&queues[d].front().due<=Now()) {
          if(current=="rate" && next_injection[d]>Now())break;
          Packet p=std::move(queues[d].front());queues[d].pop_front();schedulers[d].Complete(p.bytes.size());
          if(Now()-p.captured>2000000000LL){trace.PacketEvent(p,"queue_expired");continue;}
          if(current=="rate")next_injection[d]=Now()+static_cast<std::int64_t>((p.bytes.size()*8000000000ULL+116092)/116093);
          bool sent=WinDivertSend(handle,p.bytes.data(),static_cast<UINT>(p.bytes.size()),nullptr,&p.address)!=FALSE;
          trace.PacketEvent(p,sent?"sent":"send_failed");
        }
      }
      lock.unlock();
      LARGE_INTEGER interval{};interval.QuadPart=-10000;
      if(!SetWaitableTimer(timer.value,&interval,0,nullptr,nullptr,FALSE) || WaitForSingleObject(timer.value,1000)!=WAIT_OBJECT_0)
        throw std::runtime_error("High resolution timer failed");
    }
    stopping=true;WinDivertShutdown(handle,WINDIVERT_SHUTDOWN_RECV);receiver.join();
    for(auto& queue:queues)for(const auto& p:queue)trace.PacketEvent(p,"clear_drop");
    WinDivertClose(handle);handle=INVALID_HANDLE_VALUE;
    Write(root/"active.txt","pass");
    trace.Event("stopped",",\"receive_failed\":"+std::string(receive_failed?"true":"false"));
    CloseHandle(watchdog);watchdog=nullptr;
    return receive_failed?3:0;
  } catch(const std::exception& error) {
    std::cerr<<error.what()<<'\n';stopping=true;
    if(handle!=INVALID_HANDLE_VALUE)WinDivertShutdown(handle,WINDIVERT_SHUTDOWN_RECV);
    if(receiver.joinable())receiver.join();
    if(handle!=INVALID_HANDLE_VALUE)WinDivertClose(handle);
    if(watchdog)CloseHandle(watchdog);
    return 1;
  }
}
