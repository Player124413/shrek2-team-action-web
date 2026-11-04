// Minimal <aaudio/AAudio.h> for the host-side syntax check.
#pragma once
#include <cstdint>

typedef int32_t aaudio_result_t;
typedef struct AAudioStream AAudioStream;
typedef struct AAudioStreamBuilder AAudioStreamBuilder;

enum {
  AAUDIO_OK = 0,
  AAUDIO_ERROR_BASE = -900,
  AAUDIO_ERROR_DISCONNECTED = -899,
};
enum { AAUDIO_DIRECTION_OUTPUT = 0, AAUDIO_DIRECTION_INPUT = 1 };
enum { AAUDIO_FORMAT_PCM_FLOAT = 4 };
enum { AAUDIO_PERFORMANCE_MODE_LOW_LATENCY = 12 };
enum {
  AAUDIO_CALLBACK_RESULT_CONTINUE = 0,
  AAUDIO_CALLBACK_RESULT_STOP = 1,
};

typedef int32_t aaudio_data_callback_result_t;

typedef aaudio_data_callback_result_t (*AAudioStream_dataCallback)(AAudioStream*, void* user, void* audioData,
                                                                 int32_t numFrames);
#define AAUDIO_CALLBACK_RESULT_CONTINUE_v AAUDIO_CALLBACK_RESULT_CONTINUE

aaudio_result_t aaudio_createStreamBuilder(AAudioStreamBuilder**);
void aaudio_stream_builder_delete(AAudioStreamBuilder*);
void aaudio_stream_builder_setDirection(AAudioStreamBuilder*, int32_t);
void aaudio_stream_builder_setFormat(AAudioStreamBuilder*, int32_t);
void aaudio_stream_builder_setSampleRate(AAudioStreamBuilder*, int32_t);
void aaudio_stream_builder_setChannelCount(AAudioStreamBuilder*, int32_t);
void aaudio_stream_builder_setPerformanceMode(AAudioStreamBuilder*, int32_t);
void aaudio_stream_builder_setBufferCapacityInFrames(AAudioStreamBuilder*, int32_t);
void aaudio_stream_builder_setDataCallback(AAudioStreamBuilder*, AAudioStream_dataCallback, void*);
aaudio_result_t aaudio_stream_builder_build(AAudioStreamBuilder*, AAudioStream**);
aaudio_result_t aaudio_stream_request_start(AAudioStream*);
aaudio_result_t aaudio_stream_stop(AAudioStream*);
aaudio_result_t aaudio_stream_close(AAudioStream*);
const char* AAudio_convertResultToText(aaudio_result_t);
