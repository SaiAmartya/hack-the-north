#include "accel.h"
#include "proto.h"
#include <cstdio>

static_assert(accel::signed_counts(0x80, 0x3e) == 1000, "positive native decode");
static_assert(accel::signed_counts(0x80, 0xc1) == -1000, "negative native decode");
static_assert(accel::signed_counts(0xf0, 0x7f) == 2047, "positive native rail");
static_assert(accel::signed_counts(0x00, 0x80) == -2048, "negative native rail");
static_assert(accel::signed_counts(0xa0, 0x0f) * 4 == 1000, "8 g profile positive gravity");
static_assert(accel::signed_counts(0x60, 0xf0) * 4 == -1000, "8 g profile negative gravity");

int main() { return proto::selftest([](const char *line) { std::puts(line); }); }
