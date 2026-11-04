// Minimal <aaudio/AAudio.h> for the host-side syntax check.
//
// Every name here must match the NDK exactly: the point of the check is to catch a typo before the
// Gradle job does. The AAudio API spells all its functions with a capital `AAudio` prefix
// (AAudioStreamBuilder_setSampleRate), except AAudio_createStreamBuilder and
// AAudio_convertResultToText, which start with the same capital.
#pragma once
#include <cstdint>

typedef int32_t aaudio_result_t;
typedef struct AAudioStreamStruct AAudioStream;
typedef struct AAudioStreamBuilderStruct AAudioStreamBuilder;

#define AAUDIO_OK 0
#define AAUDIO_ERROR_DISCONNECTED (-899)
#define AAUDIO_UNSPECIFIED 0

enum {
  AAUDIO_DIRECTION_OUTPUT = 0,
  AAUDIO_DIRECTION_INPUT = 1,
};
enum {
  AAUDIO_FORMAT_PCM_I16 = 1,
  AAUDIO_FORMAT_PCM_FLOAT = 2,
};
enum {
  AAUDIO_PERFORMANCE_MODE_NONE = 10,
  AAUDIO_PERFORMANCE_MODE_POWER_SAVING = 11,
  AAUDIO_PERFORMANCE_MODE_LOW_LATENCY = 12,
};
enum {
  AAUDIO_CALLBACK_RESULT_CONTINUE = 0,
  AAUDIO_CALLBACK_RESULT_STOP = 1,
};

typedef int32_t aaudio_data_callback_result_t;

typedef aaudio_data_callback_result_t (*AAudioStream_dataCallback)(AAudioStream*, void* user, void* audioData,
                                                                 int32_t numFrames);

aaudio_result_t AAudio_createStreamBuilder(AAudioStreamBuilder** builder);
void AAudioStreamBuilder_delete(AAudioStreamBuilder* builder);
void AAudioStreamBuilder_setDirection(AAudioStreamBuilder* builder, int32_t direction);
void AAudioStreamBuilder_setFormat(AAudioStreamBuilder* builder, int32_t format);
void AAudioStreamBuilder_setSampleRate(AAudioStreamBuilder* builder, int32_t sampleRate);
void AAudioStreamBuilder_setChannelCount(AAudioStreamBuilder* builder, int32_t channelCount);
void AAudioStreamBuilder_setPerformanceMode(AAudioStreamBuilder* builder, int32_t mode);
void AAudioStreamBuilder_setBufferCapacityInFrames(AAudioStreamBuilder* builder, int32_t frames);
void AAudioStreamBuilder_setDataCallback(AAudioStreamBuilder* builder, AAudioStream_dataCallback callback,
                                         void* userData);
aaudio_result_t AAudioStreamBuilder_openStream(AAudioStreamBuilder* builder, AAudioStream** stream);
aaudio_result_t AAudioStream_requestStart(AAudioStream* stream);
aaudio_result_t AAudioStream_requestStop(AAudioStream* stream);
aaudio_result_t AAudioStream_close(AAudioStream* stream);
const char* AAudio_convertResultToText(aaudio_result_t result);
