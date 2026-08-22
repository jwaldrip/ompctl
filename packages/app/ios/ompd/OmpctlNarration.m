#import <React/RCTBridgeModule.h>

/*
 * Registers the Swift OmpctlNarration class under the exact name the JS seam
 * resolves: NativeModules.OmpctlNarration. RCT_EXTERN_MODULE and
 * RCT_EXTERN_METHOD are preprocessor macros with no Swift equivalent, which is
 * why the Swift implementation needs this companion file.
 */
@interface RCT_EXTERN_MODULE(OmpctlNarration, NSObject)

RCT_EXTERN_METHOD(speak:(NSString *)text
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
