import android.os.SystemClock;
import android.view.InputEvent;
import android.view.MotionEvent;
import android.view.InputDevice;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Paths;
/** Shell-only input replay. No app code, root, accessibility, or clock overrides. */
public class PerfInput {
 public static void main(String[] args) throws Exception {
  Class<?> c=Class.forName("android.hardware.input.InputManager");
  Object manager=c.getMethod("getInstance").invoke(null);
  Method inject=c.getMethod("injectInputEvent",InputEvent.class,int.class);
  long began=SystemClock.uptimeMillis();
  for(String row:Files.readAllLines(Paths.get(args[0]))) {
   if(row.isBlank()||row.startsWith("#"))continue;
   String[] s=row.split(" ");
   long due=began+Long.parseLong(s[0]);
   SystemClock.sleep(Math.max(0,due-SystemClock.uptimeMillis()));
   float x=Float.parseFloat(s[1]), y=Float.parseFloat(s[2]);
   long down=SystemClock.uptimeMillis();
   long downNs=SystemClock.elapsedRealtimeNanos();
   MotionEvent d=MotionEvent.obtain(down,down,MotionEvent.ACTION_DOWN,x,y,0);
   d.setSource(InputDevice.SOURCE_TOUCHSCREEN);
   if(!((Boolean)inject.invoke(manager,d,2)))throw new Exception("down rejected");
   d.recycle();
   SystemClock.sleep(35);
   MotionEvent u=MotionEvent.obtain(down,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,x,y,0);
   u.setSource(InputDevice.SOURCE_TOUCHSCREEN);
   if(!((Boolean)inject.invoke(manager,u,2)))throw new Exception("up rejected");
   u.recycle();
   System.out.println(s[3]+" "+down+" "+downNs+" "+SystemClock.elapsedRealtimeNanos());
  }
 }
}
