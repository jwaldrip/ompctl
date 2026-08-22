#import <React/RCTBridgeModule.h>

/*
 * Registers the Swift OmpctlVoice class under the exact name the JS seam
 * resolves: NativeModules.OmpctlVoice. RCT_EXTERN_MODULE and
 * RCT_EXTERN_METHOD are preprocessor macros with no Swift equivalent, which is
 * why the Swift implementation needs this companion file.
 */
@interface RCT_EXTERN_MODULE(OmpctlVoice, NSObject)

RCT_EXTERN_METHOD(startCapture:(double)sampleRate
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopCapture:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(playPcm:(NSString *)base64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopPlayback:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(addListener:(NSString *)eventName
                  callback:(RCTResponseSenderBlock)callback)

RCT_EXTERN_METHOD(removeListeners:(double)count)

@end
