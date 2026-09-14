#import <React/RCTBridgeModule.h>
#import <React/RCTViewManager.h>

/**
 * Registers the Swift OmpctlCamera class under NativeModules.OmpctlCamera.
 * RCT_EXTERN_MODULE and RCT_EXTERN_METHOD are Objective-C preprocessor macros
 * with no direct Swift syntax, requiring this companion registration file.
 */
@interface RCT_EXTERN_MODULE(OmpctlCamera, NSObject)

RCT_EXTERN_METHOD(hasCamera:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getAvailableDevices:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(checkPermission:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(requestPermission:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startSession:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startSessionWithDevice:(nullable NSString *)deviceId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopSession:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(addListener:(NSString *)eventName
                  callback:(RCTResponseSenderBlock)callback)

RCT_EXTERN_METHOD(removeListeners:(double)count)

@end

/**
 * Registers the native preview view manager for macOS camera capture.
 */
@interface RCT_EXTERN_MODULE(OmpctlCameraPreviewManager, RCTViewManager)

@end
