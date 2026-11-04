// Minimal <android/input.h>: the platform layer only includes it for the source constants it maps.
#pragma once
enum {
  AINPUT_SOURCE_CLASS_POINTER = 0x00000002,
  AINPUT_SOURCE_GAMEPAD = 0x00000401,
  AINPUT_SOURCE_JOYSTICK = 0x01000010,
};
