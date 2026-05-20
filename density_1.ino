#include <Arduino.h>

/* ================= PIN CONFIG ================= */
#define TAP_PIN            35
#define USP2_ADAPTER_PIN   21  // Pin for USP2 adapter detection

#define STEP_PIN           41
#define DIR_PIN            16
#define EN_PIN             15

#define PULSES_PER_REV     800

/* ================= UART ================= */
#define UART_TX_PIN 17
#define UART_RX_PIN 18
#define UART_BAUD  9600

#define PROTO Serial1   // Raspberry Pi
#define DEBUG Serial    // USB Debug

/* ================= GLOBAL VARIABLES ================= */
hw_timer_t *stepTimer = NULL;

volatile bool motorRunning = false;
volatile bool stepState = false;

volatile int tapCount = 0;
int targetTaps = 0;
int selectedRPM = 0;

int lastSensorState = HIGH;
unsigned long lastDebounceTime = 0;

// Validation variables
bool validationMode = false;
String validationType = "";  // "usp1" or "usp2"
int validationTargetTaps = 0;
int validationCurrentTaps = 0;

// Current active adapter
String currentAdapter = "";  // "usp1", "usp2", or ""

// Adapter monitoring variables
unsigned long lastAdapterCheckTime = 0;
const unsigned long ADAPTER_CHECK_INTERVAL = 2000; // Check every 2 seconds
bool adapterErrorReported = false;

/* ================= TIMER ISR ================= */
void IRAM_ATTR onStepTimer()
{
    if (!motorRunning) return;

    stepState = !stepState;
    digitalWrite(STEP_PIN, stepState);
}

/* ================= RPM CONTROL ================= */
void motor_setRPM(int rpm)  {
    float stepsPerSec = (rpm * PULSES_PER_REV) / 60.0;
    float toggleFreq = stepsPerSec * 2.0;

    uint32_t period_us = (uint32_t)(1000000.0 / toggleFreq);
    timerAlarm(stepTimer, period_us, true, 0);
}

/* ================= ADAPTER CHECK ================= */
// Assuming adapter connects pin to GND (LOW = connected)
bool isUSP1Present()
{
    return digitalRead(TAP_PIN) == LOW;
}

bool isUSP2Present()
{
    return digitalRead(USP2_ADAPTER_PIN) == LOW;
}

String checkAdapter()
{
    bool usp1Detected = isUSP1Present();
    bool usp2Detected = isUSP2Present();
    
    DEBUG.print("USP1 Pin State: ");
    DEBUG.println(digitalRead(TAP_PIN));
    DEBUG.print("USP2 Pin State: ");
    DEBUG.println(digitalRead(USP2_ADAPTER_PIN));
    
    if (usp1Detected && !usp2Detected) {
        currentAdapter = "usp1";
        DEBUG.println("USP1 adapter detected");
        adapterErrorReported = false;
        return "usp1,ok*";
    }
    else if (usp2Detected && !usp1Detected) {
        currentAdapter = "usp2";
        DEBUG.println("USP2 adapter detected");
        adapterErrorReported = false;
        return "usp2,ok*";
    }
    else if (usp1Detected && usp2Detected) {
        // Both adapters detected - treat as USP2
        currentAdapter = "usp2";
        DEBUG.println("Both adapters detected - treating as USP2");
        adapterErrorReported = false;
        return "usp2,ok*";
    }
    else {
        // No adapter detected
        currentAdapter = "";
        DEBUG.println("ERROR: No adapter detected");
        adapterErrorReported = false;
        return "adapt,error*";
    }
}

bool isAdapterPresent(String expectedAdapter = "")
{
    bool usp1Detected = isUSP1Present();
    bool usp2Detected = isUSP2Present();
    
    if (expectedAdapter == "usp1") {
        // USP1 is only valid when ONLY USP1 is present
        return usp1Detected && !usp2Detected;
    }
    else if (expectedAdapter == "usp2") {
        // USP2 is valid when ONLY USP2 is present OR both are present
        return (usp2Detected && !usp1Detected) || (usp1Detected && usp2Detected);
    }
    else {
        // Check if any adapter is present (for validation)
        return usp1Detected || usp2Detected;
    }
}

// Function to monitor adapter during operation
void monitorAdapter()
{
    if (!motorRunning) return;
    
    unsigned long currentTime = millis();
    if (currentTime - lastAdapterCheckTime >= ADAPTER_CHECK_INTERVAL) {
        lastAdapterCheckTime = currentTime;
        
        bool adapterOk = false;
        String expectedAdapter = "";
        
        if (validationMode) {
            // During validation, check if the specific adapter is present
            expectedAdapter = validationType;
            adapterOk = isAdapterPresent(expectedAdapter);
        } else {
            // During normal operation, check if the correct adapter is present
            if (selectedRPM == 100) {
                expectedAdapter = "usp1";
                adapterOk = isAdapterPresent("usp1");
            } else if (selectedRPM == 83) {
                expectedAdapter = "usp2";
                adapterOk = isAdapterPresent("usp2");
            }
        }
        
        if (!adapterOk && !adapterErrorReported) {
            // Adapter missing or wrong adapter detected
            adapterErrorReported = true;
            
            DEBUG.print("ERROR: ");
            DEBUG.print(expectedAdapter);
            DEBUG.println(" adapter not detected during operation!");
            
            // Stop the motor
            motorRunning = false;
            digitalWrite(EN_PIN, HIGH);
            digitalWrite(STEP_PIN, LOW);
            
            // Send error message
            if (validationMode) {
                PROTO.println("adapt,error*");
                DEBUG.print("error:");
                DEBUG.print(expectedAdapter);
                DEBUG.println("_adapter_removed_during_validation*");
                
                // Clear validation mode
                validationMode = false;
                validationType = "";
                validationCurrentTaps = 0;
            } else {
                PROTO.println("adapt,error*");
                DEBUG.print("error:");
                DEBUG.print(expectedAdapter);
                DEBUG.println("_adapter_removed_during_operation*");
            }
        } else if (adapterOk) {
            // Reset error flag when adapter is present again
            adapterErrorReported = false;
        }
    }
}

/* ================= VALIDATION FUNCTIONS ================= */
void startValidation(String type, int rpm)
{
    if (motorRunning) {
        PROTO.println("error:motor_already_running*");
        DEBUG.println("error:motor_already_running*");
        return;
    }
    
    // Check if adapter is present before starting validation
    bool adapterPresent = false;
    if (type == "usp1") {
        adapterPresent = isAdapterPresent("usp1");
    } else if (type == "usp2") {
        adapterPresent = isAdapterPresent("usp2");
    }
    
    if (!adapterPresent) {
        PROTO.println("error:adapter_not_present*");
        DEBUG.println("error:adapter_not_present*");
        return;
    }
    
    // Start validation
    validationMode = true;
    validationType = type;
    selectedRPM = rpm;
    validationCurrentTaps = 0;
    validationTargetTaps = 0;  // Set to 0 for continuous running
    adapterErrorReported = false;
    lastAdapterCheckTime = millis();
    
    DEBUG.print("validation_start_");
    DEBUG.println(type);
    DEBUG.print("rpm: ");
    DEBUG.println(rpm);
    DEBUG.println("target taps: continuous until stop");
    
    motor_start();
}

void stopValidation()
{
    if (validationMode && motorRunning) {
        motor_stop();
        
        // Send validation stopped message
        PROTO.println("stopped*");
        
        DEBUG.print("validation_stopped:");
        DEBUG.print(validationType);
        DEBUG.print(" taps completed: ");
        DEBUG.println(validationCurrentTaps);
        
        validationMode = false;
        validationType = "";
        validationCurrentTaps = 0;
        adapterErrorReported = false;
    }
}

/* ================= MOTOR START ================= */
void motor_start()
{
    // Check adapter for validation mode before starting
    if (validationMode) {
        bool adapterPresent = false;
        if (validationType == "usp1") {
            adapterPresent = isAdapterPresent("usp1");
        } else if (validationType == "usp2") {
            adapterPresent = isAdapterPresent("usp2");
        }
        
        if (!adapterPresent) {
            PROTO.println("error:adapter_not_present*");
            DEBUG.println("error:adapter_not_present*");
            validationMode = false;
            return;
        }
    } else {
        // Only check adapter for normal operations
        if (!isAdapterPresent()) {
            PROTO.println("error:adapter_not_present*");
            DEBUG.println("error:adapter_not_present*");
            return;
        }
    }

    if (!validationMode) {
        tapCount = 0;
    } else {
        validationCurrentTaps = 0;
    }

    digitalWrite(DIR_PIN, HIGH);
    digitalWrite(EN_PIN, LOW);

    motor_setRPM(selectedRPM);

    motorRunning = true;
    lastAdapterCheckTime = millis(); // Reset adapter check timer
    adapterErrorReported = false;

    if (!validationMode) {
        // Single-line ack for Pi / firmware.txt (newline-terminated)
        PROTO.println("ok");
        DEBUG.print("ok:normal_start_rpm:");
        DEBUG.print(selectedRPM);
        DEBUG.print(" taps:");
        DEBUG.println(targetTaps);
    } else {
        DEBUG.print("validation_motor_started_");
        DEBUG.print(validationType);
        DEBUG.print(" rpm:");
        DEBUG.print(selectedRPM);
        DEBUG.println(" continuous mode");
        
        // Send OK response for validation start
        PROTO.println("ok");
        DEBUG.print("ok:");
        DEBUG.print(validationType);
        DEBUG.println("_validation_started*");
    }
}

/* ================= MOTOR STOP ================= */
void motor_stop()
{
    motorRunning = false;

    digitalWrite(EN_PIN, HIGH);
    digitalWrite(STEP_PIN, LOW);

    if (!validationMode) {
        // For normal operation, we don't send anything here
        // The stop message will be sent by the caller (stop command or auto-completion)
        DEBUG.println("motor_stopped");
    } else {
        // Don't send here, will be sent by stopValidation
        DEBUG.println("validation_motor_stopped");
    }
}

/* ================= TAP DETECTION ================= */
void motor_update()
{
    if (!motorRunning) return;

    int currentState = digitalRead(TAP_PIN);

    if (lastSensorState == HIGH && currentState == LOW)
    {
        if (millis() - lastDebounceTime > 10)
        {
            if (!validationMode) {
                tapCount++;
                // Show each tap - only the number
                DEBUG.println(tapCount);
                PROTO.println(tapCount);
            } else {
                validationCurrentTaps++;
                // Show each validation tap - only the number
                DEBUG.println(validationCurrentTaps);
                PROTO.println(validationCurrentTaps);
            }
            
            lastDebounceTime = millis();
        }
    }

    lastSensorState = currentState;
}

/* ================= COMMAND HANDLER ================= */
void processCommand(String cmd)
{
    cmd.trim();
    
    // Check if command ends with star - if not, reject
    if (!cmd.endsWith("*")) {
        PROTO.println("error:command_must_end_with_star*");
        DEBUG.println("error:command_must_end_with_star*");
        return;
    }
    
    // Remove trailing star
    cmd = cmd.substring(0, cmd.length() - 1);
    
    String originalCmd = cmd;
    cmd.toLowerCase();  // Convert to lowercase for case-insensitive comparison
    
    // Handle adapter check command
    if (cmd == "usp,chk") {
        String adapterStatus = checkAdapter();
        PROTO.println(adapterStatus);
        DEBUG.print("adapter_check: ");
        DEBUG.println(adapterStatus);
        return;
    }
    // Handle normal start commands for USP1 and USP2
    else if (cmd.startsWith("spd1,")) {
        // Format: spd1,50 - USP1 at 100 RPM with 50 taps
        int commaPos = cmd.indexOf(',');
        if (commaPos > 0) {
            int taps = cmd.substring(commaPos + 1).toInt();
            if (taps > 0) {
                if (validationMode) {
                    PROTO.println("error:busy_validating*");
                    DEBUG.println("error:busy_validating*");
                    return;
                }
                
                if (motorRunning) {
                    PROTO.println("error:motor_already_running*");
                    DEBUG.println("error:motor_already_running*");
                    return;
                }
                
                // Check if correct adapter is present for USP1 normal operation
                if (!isAdapterPresent("usp1")) {
                    PROTO.println("error:usp1_adapter_not_detected*");
                    DEBUG.println("error:usp1_adapter_not_detected*");
                    return;
                }
                
                targetTaps = taps;
                selectedRPM = 100;  // USP1 fixed at 100 RPM
                
                DEBUG.print("ok:spd1_start_rpm:100 taps:");
                DEBUG.println(targetTaps);
                
                motor_start();
            } else {
                PROTO.println("error:invalid_tap_count*");
                DEBUG.println("error:invalid_tap_count*");
            }
        } else {
            PROTO.println("error:invalid_format_use_spd1,taps*");
            DEBUG.println("error:invalid_format_use_spd1,taps*");
        }
        return;
    }
    else if (cmd.startsWith("spd2,")) {
        // Format: spd2,50 - USP2 at 83 RPM with 50 taps
        int commaPos = cmd.indexOf(',');
        if (commaPos > 0) {
            int taps = cmd.substring(commaPos + 1).toInt();
            if (taps > 0) {
                if (validationMode) {
                    PROTO.println("error:busy_validating*");
                    DEBUG.println("error:busy_validating*");
                    return;
                }
                
                if (motorRunning) {
                    PROTO.println("error:motor_already_running*");
                    DEBUG.println("error:motor_already_running*");
                    return;
                }
                
                // Check if correct adapter is present for USP2 normal operation
                if (!isAdapterPresent("usp2")) {
                    PROTO.println("error:usp2_adapter_not_detected*");
                    DEBUG.println("error:usp2_adapter_not_detected*");
                    return;
                }
                
                targetTaps = taps;
                selectedRPM = 83;  // USP2 fixed at 83 RPM
                
                DEBUG.print("ok:spd2_start_rpm:83 taps:");
                DEBUG.println(targetTaps);
                
                motor_start();
            } else {
                PROTO.println("error:invalid_tap_count*");
                DEBUG.println("error:invalid_tap_count*");
            }
        } else {
            PROTO.println("error:invalid_format_use_spd2,taps*");
            DEBUG.println("error:invalid_format_use_spd2,taps*");
        }
        return;
    }
    // Handle validation commands
    else if (cmd == "usp1,start") {
        // USP1 validation - fixed RPM 100, runs until stop command
        DEBUG.println("ok:usp1_validation_starting*");
        startValidation("usp1", 100);
        return;
    }
    else if (cmd == "usp2,start") {
        // USP2 validation - fixed RPM 83, runs until stop command
        DEBUG.println("ok:usp2_validation_starting*");
        startValidation("usp2", 83);
        return;
    }
    else if (cmd == "stop") {
        PROTO.print("ok*");
        DEBUG.println("ok:stop_command_received*");
        
        if (validationMode) {
            stopValidation();
        } else if (motorRunning) {
            motor_stop();
            // For normal operation stop command, send "stopped"
            PROTO.println("stopped");
            DEBUG.println("stopped");
        } else {
            PROTO.println("error:motor_not_running*");
            DEBUG.println("error:motor_not_running*");
        }
        return;
    }
    else if (cmd == "status")
    {
        if (validationMode) {
            PROTO.print("status:validating_");
            PROTO.print(validationType);
            PROTO.print(" rpm:");
            PROTO.print(selectedRPM);
            PROTO.print(" taps:");
            PROTO.println(validationCurrentTaps);
        } else if (motorRunning) {
            PROTO.print("status:running rpm:");
            PROTO.print(selectedRPM);
            PROTO.print(" taps:");
            PROTO.print(tapCount);
            PROTO.print("/");
            PROTO.println(targetTaps);
        } else {
            PROTO.println("status:idle*");
        }
    }
    else if (cmd == "help")
    {
        PROTO.println("commands:*");
        PROTO.println("usp,chk* - check adapter status*");
        PROTO.println("spd1,taps* - usp1 normal operation (100 rpm, e.g., spd1,50*)*");
        PROTO.println("spd2,taps* - usp2 normal operation (83 rpm, e.g., spd2,50*)*");
        PROTO.println("usp1,start* - start usp1 validation (100 rpm, continuous)*");
        PROTO.println("usp2,start* - start usp2 validation (83 rpm, continuous)*");
        PROTO.println("stop* - stop motor and show tap count*");
        PROTO.println("status* - show current status*");
        PROTO.println("help* - show this help*");
        DEBUG.println("help_commands_listed*");
    }
    else if (cmd.length() > 0) {
        // Unknown command
        PROTO.println("error:unknown_command*");
        DEBUG.print("error:unknown_command:");
        DEBUG.println(originalCmd);
    }
}

/* ================= SETUP ================= */
void setup()
{
    DEBUG.begin(9600);

    PROTO.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);

    pinMode(TAP_PIN, INPUT_PULLUP);
    pinMode(USP2_ADAPTER_PIN, INPUT_PULLUP);

    pinMode(STEP_PIN, OUTPUT);
    pinMode(DIR_PIN, OUTPUT);
    pinMode(EN_PIN, OUTPUT);

    digitalWrite(EN_PIN, HIGH);

    stepTimer = timerBegin(1000000);
    timerAttachInterrupt(stepTimer, &onStepTimer);

    DEBUG.println("system_ready*");
    PROTO.println("system_ready*");
    PROTO.println("type 'help*' for commands*");
    
    // Initial adapter check on startup
    DEBUG.println("Initial adapter check:");
    checkAdapter();
}

/* ================= LOOP ================= */
void loop()
{
    // Raspberry Pi Commands
    if (PROTO.available())
    {
        String cmd = PROTO.readStringUntil('\n');
        DEBUG.print("rx: ");
        DEBUG.println(cmd);

        processCommand(cmd);
    }
    
    // Debug console commands (optional)
    if (DEBUG.available())
    {
        String cmd = DEBUG.readStringUntil('\n');
        DEBUG.print("debug_cmd: ");
        DEBUG.println(cmd);
        processCommand(cmd);
    }

    // Tap count update
    motor_update();
    
    // Monitor adapter during operation (both validation and normal mode)
    monitorAdapter();
    
    // Target reached for normal operation - auto completion
    if (!validationMode && motorRunning && tapCount >= targetTaps)
    {
        motor_stop();
        // Send "completed" when target taps are reached automatically
        PROTO.println("completed");
        DEBUG.println("completed");
    }
}