#include "scheduler.h"
#include <cassert>
#include <iostream>
using namespace impairment;
int main() {
  Scheduler down(0), up(1);
  down.Reset(Mode::Rate); up.Reset(Mode::Rate);
  auto first = down.Enqueue(0, 1200);
  assert(first.due_ns == 82692325);
  assert(up.Enqueue(0, 1200).due_ns == first.due_ns);
  auto second = down.Enqueue(0, 1200);
  assert(second.due_ns == 2 * first.due_ns);
  assert(up.queued_bytes() == 1200);
  for (int i=0; i<22; ++i) assert(down.Enqueue(0,1200).result == Result::Queued);
  assert(down.Enqueue(0,1200).result == Result::QueueDrop);
  down.Reset(Mode::Delay);
  assert(down.Enqueue(100,1200).due_ns == 50000100);
  assert(down.Enqueue(200,1200).due_ns == 50000200);
  down.Complete(1200);
  down.Reset(Mode::Pass);
  for(int i=0;i<16;++i) assert(down.Enqueue(i,65535).result==Result::Queued);
  assert(down.Enqueue(17,65535).result==Result::QueueDrop);
  down.Reset(Mode::Loss); up.Reset(Mode::Loss);
  Scheduler repeat(0); repeat.Reset(Mode::Loss);
  int drops=0, different=0;
  for(int i=0;i<100000;++i) {
    auto a=down.Enqueue(i,1200), b=repeat.Enqueue(i,1200), c=up.Enqueue(i,1200);
    assert(a.result == b.result);
    drops += a.result==Result::RandomDrop;
    different += a.result!=c.result;
    if(a.result==Result::Queued) {down.Complete(1200); repeat.Complete(1200);}
    if(c.result==Result::Queued) up.Complete(1200);
  }
  assert(drops>850 && drops<1150 && different>1500);
  std::cout << "scheduler: rate budget, FIFO delay, both queue bounds, independent directions, seeded loss passed; drops=" << drops << "\n";
}
