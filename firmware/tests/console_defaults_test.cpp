#include "console.h"

int main() {
  const Settings settings = default_settings();
  return settings.rot == 3 ? 0 : 1;
}
