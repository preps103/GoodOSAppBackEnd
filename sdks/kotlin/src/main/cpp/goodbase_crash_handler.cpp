#include <jni.h>
#include <csignal>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <initializer_list>

static char marker_path[1024];
static void goodbase_signal_handler(int signal_number) {
    int fd = open(marker_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) {
        char payload[64];
        const char prefix[] = "{\"signal\":";
        int length = 0;
        memcpy(payload, prefix, sizeof(prefix)-1); length += sizeof(prefix)-1;
        int value = signal_number, start = length;
        do { payload[length++] = static_cast<char>('0' + value % 10); value /= 10; } while (value > 0);
        for (int left=start,right=length-1;left<right;left++,right--){char tmp=payload[left];payload[left]=payload[right];payload[right]=tmp;}
        payload[length++]='}'; write(fd,payload,length); fsync(fd); close(fd);
    }
    signal(signal_number, SIG_DFL); raise(signal_number);
}

extern "C" JNIEXPORT void JNICALL Java_app_goodos_goodbase_GoodbaseNativeCrash_nativeInstall(JNIEnv* env, jobject, jstring directory) {
    const char* root = env->GetStringUTFChars(directory, nullptr);
    size_t root_length = strnlen(root, sizeof(marker_path)-32);
    memcpy(marker_path, root, root_length);
    const char suffix[] = "/goodbase-native-crash.json";
    memcpy(marker_path+root_length, suffix, sizeof(suffix));
    env->ReleaseStringUTFChars(directory, root);
    for (int signal_number : {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP}) signal(signal_number, goodbase_signal_handler);
}
